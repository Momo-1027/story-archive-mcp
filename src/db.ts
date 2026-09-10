import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256(s: string) {
  return crypto.createHash("sha256").update(s).digest("hex");
}
export function newToken() {
  return crypto.randomBytes(24).toString("base64url");
}
export function cleanTag(s: string) {
  return s.trim().replace(/^#+/, "").replace(/\s+/g, " ").slice(0, 80);
}
export function splitParagraphs(content: string) {
  return content.replace(/\r\n?/g, "\n")
    .split(/\n\s*\n+/)
    .map(x => x.trim())
    .filter(Boolean);
}

export function createArchive(dbPath: string) {
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), {recursive:true});
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(fs.readFileSync(path.resolve("schema.sql"), "utf8"));

  function activity(actorId: number|null, storyId: number|null, paragraphId: number|null, action: string, detail?: unknown) {
    db.prepare(`INSERT INTO activities(actor_id,story_id,paragraph_id,action,detail)
                VALUES(?,?,?,?,?)`).run(actorId, storyId, paragraphId, action,
                  detail === undefined ? null : JSON.stringify(detail));
  }

  function actorFromToken(token: string) {
    const actor = db.prepare(`SELECT id,display_name,window_label,created_at,last_seen_at
                              FROM actors WHERE token_hash=?`).get(sha256(token)) as any;
    if (!actor) throw new Error("actor_token 无效；当前窗口请先调用 register_actor。");
    db.prepare(`UPDATE actors SET last_seen_at=datetime('now') WHERE id=?`).run(actor.id);
    return actor;
  }

  function registerActor(displayName: string, windowLabel?: string) {
    const token = newToken();
    const info = db.prepare(`INSERT INTO actors(display_name,window_label,token_hash)
                             VALUES(?,?,?)`).run(
      displayName.trim().slice(0,80),
      windowLabel?.trim().slice(0,120) || null,
      sha256(token)
    );
    return {
      actor_id: Number(info.lastInsertRowid),
      display_name: displayName.trim(),
      window_label: windowLabel?.trim() || null,
      actor_token: token,
      note: "请在当前聊天窗口内保留 actor_token；写段评或加标签时使用。"
    };
  }

  const uploadTx = db.transaction((input: {
    title:string, content:string, summary?:string, category?:string,
    sourceNote?:string, tags?:string[]
  }) => {
    const paras = splitParagraphs(input.content);
    if (!input.title.trim()) throw new Error("标题不能为空。");
    if (!paras.length) throw new Error("正文不能为空。");

    const st = db.prepare(`INSERT INTO stories(title,summary,category,source_note)
                           VALUES(?,?,?,?)`).run(
      input.title.trim(), input.summary?.trim() || null,
      input.category?.trim() || "其他", input.sourceNote?.trim() || null
    );
    const storyId = Number(st.lastInsertRowid);

    const insP = db.prepare(`INSERT INTO paragraphs(story_id,paragraph_no,content)
                             VALUES(?,?,?)`);
    const insPFts = db.prepare(`INSERT INTO paragraph_fts(rowid,content) VALUES(?,?)`);
    paras.forEach((p,i) => {
      const pi = insP.run(storyId, i+1, p);
      insPFts.run(Number(pi.lastInsertRowid), p);
    });

    db.prepare(`INSERT INTO story_fts(rowid,title,summary) VALUES(?,?,?)`)
      .run(storyId, input.title.trim(), input.summary?.trim() || "");

    for (const raw of input.tags ?? []) {
      const tag = cleanTag(raw); if (!tag) continue;
      db.prepare(`INSERT OR IGNORE INTO tags(name) VALUES(?)`).run(tag);
      const t = db.prepare(`SELECT id FROM tags WHERE name=? COLLATE NOCASE`).get(tag) as any;
      db.prepare(`INSERT OR IGNORE INTO story_tags(story_id,tag_id,added_by)
                  VALUES(?,?,NULL)`).run(storyId,t.id);
    }
    activity(null,storyId,null,"upload_story",{title:input.title.trim(),paragraphs:paras.length});
    return {story_id:storyId, paragraphs:paras.length};
  });

  function uploadStory(input: Parameters<typeof uploadTx>[0]) { return uploadTx(input); }

  function storyTags(storyId:number) {
    return (db.prepare(`SELECT t.name FROM story_tags st JOIN tags t ON t.id=st.tag_id
                        WHERE st.story_id=? ORDER BY t.name`).all(storyId) as any[]).map(x=>x.name);
  }

  function listStories(input:{tag?:string,category?:string,limit?:number,offset?:number}) {
    const limit=Math.min(Math.max(input.limit??30,1),100), offset=Math.max(input.offset??0,0);
    let rows = db.prepare(`SELECT id,title,summary,category,source_note,created_at,updated_at
                           FROM stories
                           WHERE (? IS NULL OR category=?)
                           ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(input.category??null,input.category??null,limit*3,offset) as any[];
    if (input.tag?.trim()) {
      const tag=cleanTag(input.tag).toLowerCase();
      rows=rows.filter(r=>storyTags(r.id).some((t:string)=>t.toLowerCase()===tag));
    }
    return rows.slice(0,limit).map(r=>({...r,tags:storyTags(r.id)}));
  }

  function searchPassages(input:{query:string,tags?:string[],category?:string,limit?:number}) {
    const q=input.query.trim();
    if (!q) throw new Error("query 不能为空。");
    const limit=Math.min(Math.max(input.limit??12,1),40);
    const raw=db.prepare(`
      SELECT p.id AS paragraph_id,p.story_id,p.paragraph_no,
             s.title,s.category,s.summary,
             snippet(paragraph_fts,0,'【','】','…',36) AS snippet,
             bm25(paragraph_fts) AS score
      FROM paragraph_fts
      JOIN paragraphs p ON p.id=paragraph_fts.rowid
      JOIN stories s ON s.id=p.story_id
      WHERE paragraph_fts MATCH ?
        AND (? IS NULL OR s.category=?)
      ORDER BY score
      LIMIT ?
    `).all(q,input.category??null,input.category??null,limit*5) as any[];

    const wanted=(input.tags??[]).map(cleanTag).filter(Boolean).map(x=>x.toLowerCase());
    const out=[];
    for (const row of raw) {
      const tags=storyTags(row.story_id);
      if (wanted.length && !wanted.every(w=>tags.some((t:string)=>t.toLowerCase()===w))) continue;
      out.push({...row,tags});
      if (out.length>=limit) break;
    }
    return out;
  }

  function searchStories(input:{query:string,tags?:string[],category?:string,limit?:number}) {
    const q=input.query.trim();
    if (!q) throw new Error("query 不能为空。");
    const limit=Math.min(Math.max(input.limit??10,1),30);
    const raw=db.prepare(`
      SELECT s.id AS story_id,s.title,s.summary,s.category,s.source_note,
             snippet(story_fts,0,'【','】','…',18) AS title_hit,
             snippet(story_fts,1,'【','】','…',28) AS summary_hit,
             bm25(story_fts) AS score
      FROM story_fts JOIN stories s ON s.id=story_fts.rowid
      WHERE story_fts MATCH ?
        AND (? IS NULL OR s.category=?)
      ORDER BY score LIMIT ?
    `).all(q,input.category??null,input.category??null,limit*4) as any[];
    const wanted=(input.tags??[]).map(cleanTag).filter(Boolean).map(x=>x.toLowerCase());
    return raw.filter(r=>{
      const tags=storyTags(r.story_id);
      return !wanted.length || wanted.every(w=>tags.some((t:string)=>t.toLowerCase()===w));
    }).slice(0,limit).map(r=>({...r,tags:storyTags(r.story_id)}));
  }

  function storyOutline(storyId:number) {
    const s=db.prepare(`SELECT id,title,summary,category,source_note,created_at,updated_at
                        FROM stories WHERE id=?`).get(storyId) as any;
    if (!s) throw new Error("story_id 不存在。");
    const ps=db.prepare(`SELECT id AS paragraph_id,paragraph_no,
                        CASE WHEN length(content)>120 THEN substr(content,1,120)||'…' ELSE content END AS preview
                        FROM paragraphs WHERE story_id=? ORDER BY paragraph_no`).all(storyId);
    return {...s,tags:storyTags(storyId),paragraph_count:(ps as any[]).length,paragraphs:ps};
  }

  function readParagraphsInternal(storyId:number,start:number,end:number,includeComments=true,limit40=true) {
    if (end<start) [start,end]=[end,start];
    if (limit40 && end-start>39) end=start+39;
    const s=db.prepare(`SELECT id,title,summary,category FROM stories WHERE id=?`).get(storyId) as any;
    if (!s) throw new Error("story_id 不存在。");
    const ps=db.prepare(`SELECT id AS paragraph_id,paragraph_no,content
                         FROM paragraphs WHERE story_id=? AND paragraph_no BETWEEN ? AND ?
                         ORDER BY paragraph_no`).all(storyId,start,end) as any[];
    const getComments=db.prepare(`
      SELECT c.id AS comment_id,c.body,c.reply_to,c.created_at,
             a.display_name AS actor,a.window_label
      FROM comments c JOIN actors a ON a.id=c.actor_id
      WHERE c.paragraph_id=? ORDER BY c.id
    `);
    return {
      story:{...s,tags:storyTags(storyId)},
      paragraphs: ps.map(p=>({...p,comments:includeComments?getComments.all(p.paragraph_id):undefined}))
    };
  }

  function readParagraphs(storyId:number,start:number,end:number,includeComments=true) {
    return readParagraphsInternal(storyId,start,end,includeComments,true);
  }

  function readAllParagraphs(storyId:number,includeComments=true) {
    return readParagraphsInternal(storyId,1,2147483647,includeComments,false);
  }

  function addTags(actorToken:string,storyId:number,tags:string[]) {
    const actor=actorFromToken(actorToken);
    if (!db.prepare(`SELECT 1 FROM stories WHERE id=?`).get(storyId)) throw new Error("story_id 不存在。");
    const added:string[]=[];
    const tx=db.transaction(()=>{
      for (const raw of tags) {
        const tag=cleanTag(raw); if(!tag) continue;
        db.prepare(`INSERT OR IGNORE INTO tags(name) VALUES(?)`).run(tag);
        const t=db.prepare(`SELECT id,name FROM tags WHERE name=? COLLATE NOCASE`).get(tag) as any;
        const r=db.prepare(`INSERT OR IGNORE INTO story_tags(story_id,tag_id,added_by) VALUES(?,?,?)`)
          .run(storyId,t.id,actor.id);
        if(r.changes){added.push(t.name);activity(actor.id,storyId,null,"add_tag",{tag:t.name});}
      }
    }); tx();
    return {story_id:storyId,added,tags:storyTags(storyId)};
  }

  function comment(actorToken:string,paragraphId:number,body:string,replyTo?:number) {
    const actor=actorFromToken(actorToken);
    const p=db.prepare(`SELECT id,story_id,paragraph_no FROM paragraphs WHERE id=?`).get(paragraphId) as any;
    if(!p) throw new Error("paragraph_id 不存在。");
    const clean=body.trim(); if(!clean) throw new Error("段评不能为空。");
    if(replyTo){
      const parent=db.prepare(`SELECT paragraph_id FROM comments WHERE id=?`).get(replyTo) as any;
      if(!parent || parent.paragraph_id!==paragraphId) throw new Error("reply_to 必须是同一段落的评论。");
    }
    const r=db.prepare(`INSERT INTO comments(paragraph_id,actor_id,body,reply_to) VALUES(?,?,?,?)`)
      .run(paragraphId,actor.id,clean,replyTo??null);
    const id=Number(r.lastInsertRowid);
    activity(actor.id,p.story_id,paragraphId,"comment_paragraph",
      {comment_id:id,paragraph_no:p.paragraph_no,body:clean,reply_to:replyTo??null});
    return {comment_id:id,story_id:p.story_id,paragraph_no:p.paragraph_no};
  }

  function activityFeed(input:{limit?:number,storyId?:number,actorName?:string}) {
    const where:string[]=[]; const args:any[]=[];
    if(input.storyId){where.push("ac.story_id=?");args.push(input.storyId);}
    if(input.actorName?.trim()){where.push("a.display_name=?");args.push(input.actorName.trim());}
    args.push(Math.min(Math.max(input.limit??30,1),100));
    return db.prepare(`
      SELECT ac.id AS activity_id,ac.action,ac.detail,ac.created_at,
             a.display_name AS actor,a.window_label,
             s.id AS story_id,s.title,p.paragraph_no
      FROM activities ac
      LEFT JOIN actors a ON a.id=ac.actor_id
      LEFT JOIN stories s ON s.id=ac.story_id
      LEFT JOIN paragraphs p ON p.id=ac.paragraph_id
      ${where.length?"WHERE "+where.join(" AND "):""}
      ORDER BY ac.id DESC LIMIT ?
    `).all(...args);
  }

  function listTags(limit=100) {
    return db.prepare(`
      SELECT t.name,COUNT(st.story_id) AS story_count
      FROM tags t LEFT JOIN story_tags st ON st.tag_id=t.id
      GROUP BY t.id ORDER BY story_count DESC,t.name LIMIT ?
    `).all(Math.min(Math.max(limit,1),300));
  }

  function listActors(limit=100) {
    return db.prepare(`
      SELECT a.id,a.display_name,a.window_label,a.created_at,a.last_seen_at,
             COUNT(DISTINCT c.id) AS comments,
             COUNT(DISTINCT st.story_id) AS tagged_stories
      FROM actors a
      LEFT JOIN comments c ON c.actor_id=a.id
      LEFT JOIN story_tags st ON st.added_by=a.id
      GROUP BY a.id ORDER BY a.id DESC LIMIT ?
    `).all(Math.min(Math.max(limit,1),200));
  }

  function deleteStory(storyId:number) {
    const exists=db.prepare(`SELECT title FROM stories WHERE id=?`).get(storyId) as any;
    if(!exists) return false;
    const pids=(db.prepare(`SELECT id FROM paragraphs WHERE story_id=?`).all(storyId) as any[]).map(x=>x.id);
    for(const id of pids) db.prepare(`DELETE FROM paragraph_fts WHERE rowid=?`).run(id);
    db.prepare(`DELETE FROM story_fts WHERE rowid=?`).run(storyId);
    db.prepare(`DELETE FROM stories WHERE id=?`).run(storyId);
    return true;
  }

  return {db,registerActor,actorFromToken,uploadStory,listStories,searchPassages,searchStories,
          storyOutline,readParagraphs,readAllParagraphs,addTags,comment,activityFeed,listTags,listActors,deleteStory};
}

export type Archive = ReturnType<typeof createArchive>;
