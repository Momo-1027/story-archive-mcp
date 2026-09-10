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

const archive=createArchive(DB);
const mcpHandler=createMcpHandler(()=>buildMcp(archive),{legacy:"stateless"});
const nodeMcp=toNodeHandler(mcpHandler);

const app=express();

app.get("/health",(_req,res)=>res.json({ok:true,name:"story-archive-mcp",version:"0.2.0"}));

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
