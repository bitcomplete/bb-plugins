import { describe, expect, it, vi } from "vitest";
import { LayaClient } from "../../src/adapters/laya.js";
describe("optional Laya detector",()=>{
  it("treats a truncated negative as uncertain",async()=>{
    const fetch=vi.fn(async()=>Response.json({answers:{learn:{choice:"no-learn",confidence:0.99}},usage:{truncated:true,state_tokens_dropped:4}}));
    const result=await new LayaClient({url:"https://laya.example",fetch}).classify(["A tool failed"]);
    expect(result.decision).toBe("uncertain");expect(result.complete).toBe(false);
  });
  it("does not throw on unavailable optional inference",async()=>{
    const fetch=vi.fn(async()=>new Response(null,{status:503,headers:{"retry-after":"2"}}));
    const result=await new LayaClient({url:"https://laya.example",fetch}).classify(["failure"]);
    expect(result).toMatchObject({decision:"uncertain",reason:"busy",retryAfterMs:2000});
  });
  it("checks real token budget and rejects oversized context before the call",async()=>{
    const fetch=vi.fn();const client=new LayaClient({url:"https://laya.example",fetch,countTokens:()=>600});
    expect(await client.classify(["long"])).toMatchObject({decision:"uncertain",reason:"input-too-large"});
    expect(fetch).not.toHaveBeenCalled();
  });
  it("treats absent truncation telemetry as uncertain",async()=>{
    expect(await new LayaClient({url:"https://laya.example",fetch:async()=>Response.json({answers:{learn:{choice:"learn",confidence:0.99}}})}).classify(["failure"])).toMatchObject({decision:"uncertain",complete:false,reason:"missing-truncation-evidence"});
  });
  it("uses the configured confidence threshold and rejects out-of-range confidence",async()=>{
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{expect(JSON.parse(String(init?.body)).min_confidence).toBe(.95);return Response.json({answers:{learn:{choice:"learn",confidence:1.5}},usage:{truncated:false,state_tokens_dropped:0,truncated_questions:[]}});});
    expect(await new LayaClient({url:"https://laya.example",fetch,minConfidence:.95}).classify(["failure"])).toMatchObject({decision:"uncertain",complete:false});
  });

});
