import { createHash } from "node:crypto";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import type { Clock, Fetch, Paper } from "./types.js";
import { AdapterError, asObject, boundedText, clock as realClock, defaultFetch, endpoint, requestSignal, retryAfter } from "./transport.js";

export interface ResearchState {
  get<T>(key:string):Promise<T|null>;
  set(key:string,value:unknown):Promise<void>;
  /** Must be one shared lease for all arXiv traffic, held until the body is read. */
  exclusive<T>(operation:()=>Promise<T>):Promise<T>;
}
/** Tests/single-run use only; production passes a durable, shared coordinator. */
export class MemoryResearchState implements ResearchState {
  private values=new Map<string,unknown>();private tail:Promise<void>=Promise.resolve();
  async get<T>(key:string):Promise<T|null>{return (this.values.get(key) as T)??null;}
  async set(key:string,value:unknown){this.values.set(key,value);}
  async exclusive<T>(operation:()=>Promise<T>):Promise<T>{const previous=this.tail;let release!:()=>void;this.tail=new Promise(r=>{release=r;});await previous;try{return await operation();}finally{release();}}
}
const strings=(value:unknown):unknown[]=>value===undefined?[]:Array.isArray(value)?value:[value];
const requiredString=(value:unknown):string=>{if(typeof value!=="string"||!value.trim())throw new AdapterError("invalid-paper","Research metadata is missing a required text field");return value.trim();};
export function parseArxiv(xml:string,now:Date):Paper[]{
  if(Buffer.byteLength(xml)>2_000_000||/<!DOCTYPE|<!ENTITY/i.test(xml))throw new AdapterError("unsafe-xml","Research XML exceeds its limit or declares forbidden entities");
  if(XMLValidator.validate(xml)!==true)throw new AdapterError("invalid-xml","Invalid arXiv XML response");
  const parsed=new XMLParser({ignoreAttributes:true,removeNSPrefix:true,parseTagValue:false,trimValues:true,processEntities:true}).parse(xml);
  const feed=asObject(asObject(parsed).feed);
  return strings(feed.entry).map(raw=>{
    const e=asObject(raw);const sourceId=requiredString(e.id);let url:URL;
    try{url=new URL(sourceId);}catch{throw new AdapterError("invalid-paper","Invalid arXiv identifier");}
    if(!["arxiv.org","export.arxiv.org"].includes(url.hostname))throw new AdapterError("invalid-paper","Unexpected arXiv identifier host");
    const id=url.pathname.replace(/^\/abs\//,"");
    const match=id.match(/^((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7}))(v\d+)$/i);
    if(!match)throw new AdapterError("invalid-paper","Unversioned or invalid arXiv identifier");
    const publishedAt=requiredString(e.published),updatedAt=requiredString(e.updated);
    if(!Number.isFinite(Date.parse(publishedAt))||!Number.isFinite(Date.parse(updatedAt)))throw new AdapterError("invalid-paper","Invalid paper timestamps");
    return {id:match[1],version:match[2],title:requiredString(e.title),abstract:requiredString(e.summary),authors:strings(e.author).map(a=>requiredString(asObject(a).name)),publishedAt,updatedAt,url:`https://arxiv.org/abs/${match[1]}${match[2]}`,source:"arxiv" as const,fwci:null,authorSignal:null,retrievedAt:now.toISOString()};
  });
}
export function paperGate(paper:Paper,now:Date,minimumFwci=1,minimumAuthorSignal=1):string[]{
  const reasons:string[]=[];const age=now.getTime()-Date.parse(paper.publishedAt);
  if(!Number.isFinite(age)||age<7*86_400_000)reasons.push("too-young");
  if(paper.fwci===null||!Number.isFinite(paper.fwci))reasons.push("missing-citation-evidence");else if(paper.fwci<minimumFwci)reasons.push("citation-gate");
  if(paper.authorSignal===null||!Number.isFinite(paper.authorSignal))reasons.push("missing-author-evidence");else if(paper.authorSignal<minimumAuthorSignal)reasons.push("author-gate");
  if(paper.fwci!==null&&paper.authorSignal!==null&&!paper.credibilityEvidenceUrls?.length)reasons.push("missing-metric-provenance");
  return reasons;
}
export interface PaperFullText {paperId:string;version:string;url:string;text:string;sha256:string;retrievedAt:string}
/** A bounded text extractor, never a browser: no scripts, resources, or links execute. */
function htmlTagEnd(source:string,start:number):number {
  let quote:string|null=null;
  for(let i=start+1;i<source.length;i++){
    const char=source[i];if(quote){if(char===quote)quote=null;}
    else if(char==='"'||char==="'")quote=char;else if(char==='>')return i;
  }
  return -1;
}
export function parseArxivFullText(html:string):string {
  if(Buffer.byteLength(html)>4_000_000)throw new AdapterError("invalid-full-text","arXiv HTML exceeds its bounded limit");
  let begin=-1;
  // Match only bounded individual tags; avoid a regex that rescans an entire
  // adversarial page for each unterminated opening tag.
  for(let offset=0;offset<html.length;){
    const open=html.indexOf('<',offset);if(open<0)break;
    if(html.startsWith('<!--',open)){const close=html.indexOf('-->',open+4);if(close<0)throw new AdapterError("invalid-full-text","Incomplete HTML comment");offset=close+3;continue;}
    const close=htmlTagEnd(html,open);if(close<0)throw new AdapterError("invalid-full-text","Invalid or oversized HTML tag");
    const tag=html.slice(open,Math.min(close+1,open+16_001));
    if(/^<article\b/i.test(tag)&&close-open>16_000)throw new AdapterError("invalid-full-text","Oversized paper article tag");
    if(/^<article\b/i.test(tag)&&/\bclass\s*=\s*["'][^"']*\bltx_document\b[^"']*["']/i.test(tag)){begin=close+1;break;}
    offset=close+1;
  }
  if(begin<0)throw new AdapterError("invalid-full-text","arXiv HTML does not contain a paper article");
  const source=html.slice(begin),lower=source.toLowerCase(),parts:string[]=[];let complete=false;
  // Scan once. Stripping tags is only text extraction; it is not an HTML sanitizer.
  for(let i=0;i<source.length;){
    if(source[i]!=="<"){const end=source.indexOf("<",i);parts.push(source.slice(i,end<0?source.length:end));i=end<0?source.length:end;continue;}
    if(source.startsWith('<!--',i)){const end=source.indexOf('-->',i+4);if(end<0)throw new AdapterError("invalid-full-text","Incomplete HTML comment");i=end+3;continue;}
    const end=htmlTagEnd(source,i);if(end<0)throw new AdapterError("invalid-full-text","Incomplete HTML tag");
    const prefix=source.slice(i,Math.min(end+1,i+128));
    if(/^<\/article\s*>$/i.test(prefix)){complete=true;break;}
    const tag=/^<\s*([a-z][a-z0-9]*)\b/i.exec(prefix)?.[1]?.toLowerCase();
    if(tag&&['script','style','noscript','svg','nav','header','footer'].includes(tag)){
      const close=lower.indexOf('</'+tag,i+1);if(close<0)throw new AdapterError("invalid-full-text","Incomplete ignored HTML element");
      const closeEnd=htmlTagEnd(source,close);if(closeEnd<0)throw new AdapterError("invalid-full-text","Incomplete HTML element");i=closeEnd+1;
    }else i=end+1;
    parts.push(' ');
  }
  if(!complete)throw new AdapterError("invalid-full-text","arXiv paper article is incomplete");
  const named:Record<string,string>={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '};
  const text=parts.join('').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_all,entity:string)=>{
    if(entity[0]!=='#')return named[entity.toLowerCase()]??' ';
    const code=entity[1]?.toLowerCase()==='x'?parseInt(entity.slice(2),16):parseInt(entity.slice(1),10);
    return Number.isSafeInteger(code)&&code>0&&code<=0x10ffff&&!(code>=0xd800&&code<=0xdfff)?String.fromCodePoint(code):' ';
  }).replace(/\s+/g,' ').trim();
  if(text.length<200||Buffer.byteLength(text)>300_000)throw new AdapterError("invalid-full-text","Paper text is too short or exceeds its bounded limit");
  return text;
}
interface ArxivOptions {fetch?:Fetch;clock?:Clock;state:ResearchState;url?:string;allowLoopback?:boolean;cacheTtlMs?:number;onRequest?:(input:{status:number|null;durationMs:number;cached:boolean})=>Promise<void>}
export class ArxivClient {
  private readonly fetch:Fetch;private readonly clock:Clock;
  constructor(private readonly options:ArxivOptions){this.fetch=options.fetch??defaultFetch;this.clock=options.clock??realClock;}
  async fullText(paper:Paper,options:{signal?:AbortSignal}={}):Promise<PaperFullText|null>{
    // Never follow a supplied source URL or permit legacy identifiers to become paths.
    if(!/^\d{4}\.\d{4,5}$/.test(paper.id)||!/^v[1-9]\d{0,3}$/.test(paper.version))return null;
    const url=`https://arxiv.org/html/${paper.id}${paper.version}`,key=`arxiv:full-text:${paper.id}${paper.version}`;
    const signal=requestSignal(options.signal,120_000);
    return this.options.state.exclusive(async()=>{
      signal.throwIfAborted();const cached=await this.options.state.get<{at:number;value:PaperFullText|null}>(key);
      if(cached&&this.clock.now()-cached.at<(cached.value?(this.options.cacheTtlMs??86_400_000):1_800_000)){await this.options.onRequest?.({status:cached.value?200:null,durationMs:0,cached:true});return structuredClone(cached.value);}
      for(let attempt=0;attempt<3;attempt++){
        const next=await this.options.state.get<number>("arxiv:next-request-at")??0;
        await this.clock.sleep(Math.max(0,next-this.clock.now()),signal);signal.throwIfAborted();
        const began=this.clock.now();await this.options.state.set("arxiv:next-request-at",began+3000);
        let response:Response|undefined,value:PaperFullText|null=null,retry=false;
        try{
          response=await this.fetch(url,{signal,redirect:"error",headers:{accept:"text/html","user-agent":"bb-self-improve/0.1 (arXiv research client)"}});
          if(!response.ok){
            await response.body?.cancel();retry=(response.status===429||response.status>=500)&&attempt<2;
            if(retry)await this.options.state.set("arxiv:next-request-at",Math.max(began+3000,this.clock.now()+(retryAfter(response.headers,this.clock.now())??3000*(2**attempt))));
          }else if(response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()!=='text/html')await response.body?.cancel();
          else {const text=parseArxivFullText(await boundedText(response,4_000_000));value={paperId:paper.id,version:paper.version,url,text,sha256:createHash('sha256').update(text).digest('hex'),retrievedAt:new Date(this.clock.now()).toISOString()};}
        }catch{signal.throwIfAborted();}
        finally{await this.options.onRequest?.({status:response?.status??null,durationMs:this.clock.now()-began,cached:false});}
        if(retry)continue;
        await this.options.state.set(key,{at:this.clock.now(),value});return value;
      }
      return null;
    });
  }

  search(query:string,options:{start?:number;limit?:number;sortBy?:"relevance"|"lastUpdatedDate"|"submittedDate";signal?:AbortSignal}={}):Promise<Paper[]>{
    if(typeof query!=="string"||query.length<1||query.length>2000)throw new AdapterError("invalid-query","Research query must contain 1–2000 characters");
    const start=options.start??0,limit=options.limit??20;
    if(!Number.isSafeInteger(start)||start<0||start>30_000||!Number.isSafeInteger(limit)||limit<1||limit>100)throw new AdapterError("invalid-page","Research page must be bounded (at most 100 entries)");
    const url=endpoint(this.options.url??"https://export.arxiv.org","/api/query",this.options.allowLoopback);
    url.search=new URLSearchParams({search_query:query,start:String(start),max_results:String(limit),sortBy:options.sortBy??"relevance",sortOrder:"descending"}).toString();
    const cacheKey=`arxiv:cache:${createHash("sha256").update(url.toString()).digest("hex")}`;
    const signal=requestSignal(options.signal,120_000);
    return this.options.state.exclusive(async()=>{
      signal.throwIfAborted();const cached=await this.options.state.get<{at:number;papers:Paper[]}>(cacheKey);
      if(cached&&this.clock.now()-cached.at<(this.options.cacheTtlMs??86_400_000)){await this.options.onRequest?.({status:200,durationMs:0,cached:true});return structuredClone(cached.papers);}
      for(let attempt=0;attempt<3;attempt++){
        const next=await this.options.state.get<number>("arxiv:next-request-at")??0;
        await this.clock.sleep(Math.max(0,next-this.clock.now()),signal);
        const began=this.clock.now();await this.options.state.set("arxiv:next-request-at",began+3000);
        let response:Response;
        try{response=await this.fetch(url,{signal,redirect:"error",headers:{accept:"application/atom+xml","user-agent":"bb-self-improve/0.1 (arXiv metadata client)"}});}
        catch{await this.options.onRequest?.({status:null,durationMs:this.clock.now()-began,cached:false});throw new AdapterError("research-unavailable","arXiv request failed; cursor remains unchanged");}
        if(!response.ok){
          const delay=retryAfter(response.headers,this.clock.now())??3000*(2**attempt);await response.body?.cancel();
          await this.options.onRequest?.({status:response.status,durationMs:this.clock.now()-began,cached:false});
          if((response.status===429||response.status>=500)&&attempt<2){await this.options.state.set("arxiv:next-request-at",Math.max(began+3000,this.clock.now()+delay));continue;}
          throw new AdapterError("research-rejected",`arXiv returned HTTP ${response.status}`,response.status);
        }
        let papers:Paper[];
        try{papers=parseArxiv(await boundedText(response),new Date(this.clock.now()));}
        finally{await this.options.onRequest?.({status:response.status,durationMs:this.clock.now()-began,cached:false});}
        await this.options.state.set(cacheKey,{at:this.clock.now(),papers});return papers;
      }
      throw new AdapterError("research-unavailable","arXiv retry limit reached");
    });
  }
}

interface Tool {name:string;description?:string;inputSchema:Record<string,unknown>}
interface DairOptions {fetch?:Fetch;url?:string;token?:string;allowLoopback?:boolean;onRequest?:(method:string,status:number|null)=>Promise<void>}
export class DairClient {
  private readonly fetch:Fetch;private session:string|null=null;private protocol="2025-03-26";private sequence=0;private initialized=false;private initPromise:Promise<void>|null=null;private discovered:Tool[]|null=null;
  constructor(private readonly options:DairOptions){this.fetch=options.fetch??defaultFetch;endpoint(options.url??"https://academy.dair.ai/api/mcp","",options.allowLoopback);}
  private async rpc(method:string,params:unknown,signal?:AbortSignal,notification=false):Promise<unknown>{
    const id=notification?undefined:++this.sequence;
    let response:Response;
    try{response=await this.fetch(endpoint(this.options.url??"https://academy.dair.ai/api/mcp","",this.options.allowLoopback),{
      method:"POST",redirect:"error",signal:requestSignal(signal,30_000),headers:{"content-type":"application/json",accept:"application/json, text/event-stream",...(this.options.token?{authorization:`Bearer ${this.options.token}`}:{}) ,...(this.session?{"Mcp-Session-Id":this.session}:{}),...(this.initialized?{"MCP-Protocol-Version":this.protocol}:{})},body:JSON.stringify({jsonrpc:"2.0",...(id!==undefined?{id}:{}),method,params}),
    });}catch{await this.options.onRequest?.(method,null);throw new AdapterError("dair-unavailable","DAIR MCP network request failed");}
    await this.options.onRequest?.(method,response.status);
    if(!response.ok){await response.body?.cancel();throw new AdapterError(response.status===401?"dair-auth-required":"dair-unavailable",`DAIR MCP returned HTTP ${response.status}; configure OAuth or use arXiv fallback`,response.status);}
    const session=response.headers.get("mcp-session-id");if(session){if(session.length>512||/[\r\n]/.test(session))throw new AdapterError("dair-invalid-session","Invalid MCP session header");this.session=session;}
    if(notification){await response.body?.cancel();return null;}
    const text=await boundedText(response,2_000_000);let envelope:Record<string,unknown>|null=null;
    try{
      if(response.headers.get("content-type")?.includes("text/event-stream")){
        for(const event of text.split(/\r?\n\r?\n/)){
          const data=event.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
          if(!data)continue;const parsed=asObject(JSON.parse(data));if(parsed.id===id)envelope=parsed;
        }
      }else envelope=asObject(JSON.parse(text));
    }catch{throw new AdapterError("dair-invalid-response","DAIR MCP returned invalid JSON/SSE");}
    if(!envelope||envelope.jsonrpc!=="2.0"||envelope.id!==id)throw new AdapterError("dair-invalid-response","DAIR MCP response ID did not match request");
    if(envelope.error)throw new AdapterError("dair-tool-error","DAIR MCP rejected the tool request");
    return envelope.result;
  }
  private async initialize(signal?:AbortSignal):Promise<void>{
    if(this.initialized)return;
    if(!this.initPromise)this.initPromise=(async()=>{
      const result=asObject(await this.rpc("initialize",{protocolVersion:this.protocol,capabilities:{},clientInfo:{name:"bb-self-improve",version:"0.1.0"}},signal));
      if(!["2024-11-05","2025-03-26","2025-06-18"].includes(String(result.protocolVersion)))throw new AdapterError("dair-protocol","Unsupported DAIR MCP protocol version");
      this.protocol=String(result.protocolVersion);await this.rpc("notifications/initialized",{},signal,true);this.initialized=true;
    })().catch(error=>{this.initPromise=null;throw error;});
    await this.initPromise;
  }
  async tools(signal?:AbortSignal):Promise<Tool[]>{
    await this.initialize(signal);if(this.discovered)return structuredClone(this.discovered);
    const tools:Tool[]=[];let cursor:string|undefined;const seen=new Set<string>();
    for(let page=0;page<20;page++){
      const result=asObject(await this.rpc("tools/list",cursor?{cursor}:{},signal));
      if(!Array.isArray(result.tools))throw new AdapterError("dair-invalid-tools","DAIR MCP tool list is invalid");
      for(const raw of result.tools){const tool=asObject(raw);if(typeof tool.name!=="string"||tool.name.length>128||seen.has(tool.name))throw new AdapterError("dair-invalid-tools","DAIR MCP tool name is invalid or duplicated");seen.add(tool.name);tools.push({name:tool.name,...(typeof tool.description==="string"?{description:tool.description}:{}),inputSchema:asObject(tool.inputSchema)});}
      if(result.nextCursor===undefined){this.discovered=tools;return structuredClone(tools);}
      if(typeof result.nextCursor!=="string"||result.nextCursor===cursor)throw new AdapterError("dair-invalid-tools","DAIR MCP pagination did not advance");cursor=result.nextCursor;
    }
    throw new AdapterError("dair-tool-limit","DAIR MCP tool discovery exceeded its page limit");
  }
  async callTool(name:string,args:Record<string,unknown>,signal?:AbortSignal):Promise<unknown>{
    const tools=await this.tools(signal);if(!tools.some(t=>t.name===name))throw new AdapterError("dair-unknown-tool","Configured DAIR tool is not advertised by the server");
    if(Buffer.byteLength(JSON.stringify(args))>32_000)throw new AdapterError("dair-input-limit","DAIR tool arguments exceed size limit");
    const result=asObject(await this.rpc("tools/call",{name,arguments:args},signal));
    if(result.isError===true)throw new AdapterError("dair-tool-error","DAIR tool reported a failure");return result;
  }
}
