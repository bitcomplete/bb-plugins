import { describe, expect, it, vi } from "vitest";
import { parseArxiv, paperGate, ArxivClient, MemoryResearchState, DairClient, parseArxivFullText } from "../../src/adapters/research.js";
const xml=`<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>http://arxiv.org/abs/2609.14858v2</id><published>2026-09-14T00:00:00Z</published><updated>2026-10-06T00:00:00Z</updated><title>A &amp; B</title><summary>Test paper.</summary><author><name>Researcher</name></author></entry></feed>`;
describe("arXiv discovery",()=>{
  it("preserves versions and leaves unavailable credibility unknown",()=>{
    const p=parseArxiv(xml,new Date("2026-11-18T00:00:00Z"))[0];
    expect(p).toMatchObject({id:"2609.14858",version:"v2",title:"A & B",fwci:null,authorSignal:null});
    expect(paperGate(p,new Date("2026-11-18T00:00:00Z"))).toContain("missing-citation-evidence");
  });
  it("refuses XML entities and malformed XML",()=>{
    expect(()=>parseArxiv('<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><feed/>',new Date())).toThrow();
    expect(()=>parseArxiv('<feed><entry></feed>',new Date())).toThrow();
  });
  it("serializes calls, persists throttle and caches repeated queries",async()=>{
    let now=0; const sleeps:number[]=[]; const fetch=vi.fn(async()=>new Response(xml));
    const client=new ArxivClient({fetch,state:new MemoryResearchState(),clock:{now:()=>now,sleep:async(ms)=>{sleeps.push(ms);now+=ms;}}});
    await Promise.all([client.search("first"),client.search("second")]);
    await client.search("first");
    expect(fetch).toHaveBeenCalledTimes(2); expect(sleeps).toContain(3000);
  });
  it("honors a persisted next-request timestamp after a fresh client is created",async()=>{
    let now=1000;const state=new MemoryResearchState();await state.set("arxiv:next-request-at",7000);const fetch=vi.fn(async()=>new Response(xml));
    await new ArxivClient({state,fetch,clock:{now:()=>now,sleep:async ms=>{now+=ms;}}}).search("restart");
    expect(now).toBe(7000);expect(await state.get("arxiv:next-request-at")).toBe(10000);
  });
  it("does not pass credibility merely because an adapter supplied unsupported numeric metrics",()=>{
    const p=parseArxiv(xml,new Date())[0];p.fwci=2;p.authorSignal=3;
    expect(paperGate(p,new Date("2026-11-18T00:00:00Z"))).toContain("missing-metric-provenance");
  });
  it("records a completed network request even when XML parsing fails",async()=>{
    const onRequest=vi.fn(async()=>{});
    await expect(new ArxivClient({state:new MemoryResearchState(),fetch:async()=>new Response("<bad"),onRequest}).search("invalid")).rejects.toThrow();
    expect(onRequest).toHaveBeenCalledTimes(1);expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({status:200,cached:false}));
  });

});
describe("DAIR MCP",()=>{
  it("initializes and discovers actual tool names; it does not guess an archive tool",async()=>{
    const methods:string[]=[];
    const fetch=vi.fn(async(_url:unknown,init?:RequestInit)=>{
      const body=JSON.parse(String(init?.body));methods.push(body.method);
      if(body.method==="notifications/initialized")return new Response(null,{status:202});
      return Response.json({jsonrpc:"2.0",id:body.id,result:body.method==="initialize"?{protocolVersion:"2025-03-26",capabilities:{}}:{tools:[{name:"find_papers",inputSchema:{type:"object"}}]}});
    });
    const tools=await new DairClient({fetch,token:"secret"}).tools();
    expect(tools[0].name).toBe("find_papers");expect(methods).toEqual(["initialize","notifications/initialized","tools/list"]);
  });
  it("does not send guessed tool calls or leak remote authentication errors",async()=>{
    const fetch=vi.fn(async()=>new Response("TOKENSECRET",{status:401}));
    await expect(new DairClient({fetch,token:"TOKENSECRET"}).callTool("guessed",{})).rejects.toThrow("configure OAuth");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

const fullHtml='<html><head><script>doNotKeep()</script></head><body><nav>Do not keep navigation</nav><article class="ltx_document"><h1>Controlled test</h1><p>'+('We compared the intervention with a held-out baseline. ').repeat(6)+'&amp; checked results.</p><script>stealSecrets()</script><style>hidden</style></article></body></html>';
describe("arXiv full-text evidence",()=>{
  const paper=()=>parseArxiv(xml,new Date("2026-11-18T00:00:00Z"))[0]!;
  it("extracts bounded article text without code, navigation, or attributes",()=>{
    const text=parseArxivFullText(fullHtml);
    expect(text).toContain("& checked results.");expect(text).not.toMatch(/doNotKeep|navigation|stealSecrets|hidden|ltx_document/);
    expect(parseArxivFullText(fullHtml.replace('<p>','<img alt="a > b" src="data:image/png;base64,'+'x'.repeat(20000)+'"><p>'))).toBe(text);
    expect(()=>parseArxivFullText('<article class="ltx_document">short</article>')).toThrow();
    expect(()=>parseArxivFullText(fullHtml.replace('</article>',''))).toThrow();
    expect(()=>parseArxivFullText('<html>Error page</html>')).toThrow();
    expect(()=>parseArxivFullText('<article '+('x'.repeat(17000))+'>')).toThrow();
  });
  it("shares one durable throttle with search and caches canonical versioned HTML",async()=>{
    let now=0;const calls:string[]=[];const state=new MemoryResearchState();
    const fetch=vi.fn(async(url:unknown,init?:RequestInit)=>{calls.push(String(url));expect(init?.redirect).toBe('error');return new Response(String(url).includes('/html/')?fullHtml:xml,{headers:{'content-type':String(url).includes('/html/')?'text/html':'application/atom+xml'}});});
    const client=new ArxivClient({state,fetch,clock:{now:()=>now,sleep:async ms=>{now+=ms;}}});
    await client.search('validation');const result=await client.fullText({...paper(),url:'https://evil.example/secret'});
    expect(now).toBe(3000);expect(result).toMatchObject({paperId:'2609.14858',version:'v2',url:'https://arxiv.org/html/2609.14858v2'});expect(result?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await client.fullText(paper())).toEqual(result);expect(calls).toHaveLength(2);
    expect(await client.fullText({...paper(),id:'2609.14858/../../secret'})).toBeNull();expect(calls).toHaveLength(2);
  });
  it("retains unknown strength when HTML is unavailable or an error page is returned",async()=>{
    const onRequest=vi.fn(async()=>{});const client=new ArxivClient({state:new MemoryResearchState(),fetch:async()=>new Response('no',{status:404}),onRequest});
    expect(await client.fullText(paper())).toBeNull();expect(onRequest).toHaveBeenCalledWith(expect.objectContaining({status:404,cached:false}));
    expect(await new ArxivClient({state:new MemoryResearchState(),fetch:async()=>new Response('<html>not an article</html>',{headers:{'content-type':'text/html'}})}).fullText(paper())).toBeNull();
  });
});
