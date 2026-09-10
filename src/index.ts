import express from "express";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createArchive } from "./db.js";
import { buildMcp } from "./mcp.js";
import { buildWeb } from "./web.js";

const PORT=Number(process.env.PORT||8787);
const DB=process.env.ARCHIVE_DB||"./data/archive.sqlite";
const MCP_API_KEY=process.env.MCP_API_KEY||"";
const ADMIN_USER=process.env.ADMIN_USER||"xiaojiu";
const ADMIN_PASSWORD=process.env.ADMIN_PASSWORD||"";

function normalizeForParagraphs(content:string){
  const blocks=content.replace(/\r\n?/g,"\n")
    .split(/\n\s*\n+/)
    .map(x=>x.trim())
    .filter(Boolean);

  const out:string[]=[];
  let pending:string[]=[];
  const looksLikeHeading=(block:string)=>{
    if(block.includes("\n")) return false;
    const plain=block.replace(/^#{1,6}\s*/,"").trim();
    if(!plain || plain.length>28) return false;
    if(/[。！？!?；;，,。…]$/.test(plain)) return false;
    return true;
  };

  for(const block of blocks){
    if(looksLikeHeading(block)){
      pending.push(block);
      continue;
    }
    out.push(pending.length ? [...pending,block].join("\n") : block);
    pending=[];
  }
  if(pending.length){
    if(out.length) out[out.length-1]+="\n"+pending.join("\n");
    else out.push(pending.join("\n"));
  }
  return out.join("\n\n");
}

const archive=createArchive(DB);
const originalUpload=archive.uploadStory;
archive.uploadStory=((input:any)=>originalUpload({...input,content:normalizeForParagraphs(input.content)})) as typeof archive.uploadStory;

const mcpHandler=createMcpHandler(()=>buildMcp(archive),{legacy:"stateless"});
const nodeMcp=toNodeHandler(mcpHandler);

const app=express();

app.get("/health",(_req,res)=>res.json({ok:true,name:"story-archive-mcp",version:"0.2.1"}));

app.use("/mcp",(req,res,next)=>{
  if(!MCP_API_KEY) return next();
  const auth=req.headers.authorization||"";
  if(auth===`Bearer ${MCP_API_KEY}`) return next();
  res.status(401).json({error:"Unauthorized"});
});
app.all("/mcp",(req,res)=>void nodeMcp(req,res));

app.use("/",buildWeb(archive,ADMIN_USER,ADMIN_PASSWORD));

app.listen(PORT,"0.0.0.0",()=>{
  console.log(`Story Archive UI: http://localhost:${PORT}/`);
  console.log(`MCP endpoint:      http://localhost:${PORT}/mcp`);
});
