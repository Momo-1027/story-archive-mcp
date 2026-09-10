import express from "express";
import type { Archive } from "./db.js";

const esc = (x: unknown) => String(x ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function auth(adminUser?: string, adminPassword?: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (!adminPassword) return next();
    const h = req.headers.authorization || "";
    if (h.startsWith("Basic ")) {
      try {
        const [u, p] = Buffer.from(h.slice(6), "base64").toString().split(":");
        if (u === (adminUser || "xiaojiu") && p === adminPassword) return next();
      } catch {}
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Story Archive"');
    res.status(401).send("Authentication required");
  };
}

function page(title: string, body: string) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)}</title><style>
  body{font:15px/1.7 system-ui,-apple-system,sans-serif;max-width:1100px;margin:28px auto;padding:0 18px;color:#202124;background:#f7f7f8}
  a{color:#4f46e5;text-decoration:none}.card{background:#fff;border:1px solid #e3e3e7;border-radius:14px;padding:16px;margin:12px 0}
  textarea{width:100%;box-sizing:border-box;min-height:430px;padding:12px;border:1px solid #ccc;border-radius:10px;font:14px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace}
  button{padding:9px 14px;border:1px solid #bbb;border-radius:8px;background:#fff;cursor:pointer}.toolbar{display:flex;gap:10px;flex-wrap:wrap;margin:12px 0}
  .meta{color:#777;font-size:13px}.preview{white-space:pre-wrap}.pill{display:inline-block;background:#eeeef5;border-radius:999px;padding:2px 9px;font-size:12px}
  </style></head><body>
  <div class="toolbar"><a href="/">← 档案</a><a href="/segments">分段工具</a></div>${body}</body></html>`;
}

function storySource(archive: Archive, storyId: number) {
  const db = archive.db;
  const rows = db.prepare(`
    SELECT cb.block_no,cb.block_type,cb.caption,p.content,si.slot_no
    FROM content_blocks cb
    LEFT JOIN paragraphs p ON p.id=cb.paragraph_id
    LEFT JOIN story_images si ON si.id=cb.image_id
    WHERE cb.story_id=? ORDER BY cb.block_no
  `).all(storyId) as any[];

  if (!rows.length) {
    const s = db.prepare("SELECT raw_content FROM stories WHERE id=?").get(storyId) as any;
    return String(s?.raw_content || "");
  }

  const parts: string[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.block_type === "image") {
      const caption = String(row.caption || "").trim();
      parts.push(`[[image:${row.slot_no}${caption ? `|${caption}` : ""}]]`);
    } else {
      parts.push(String(row.content || ""));
      const next = rows[i + 1];
      if (next?.block_type === "text") parts.push("[[P]]");
    }
  }
  return parts.join("\n\n");
}

type ManualBlock =
  | { type: "text"; text: string }
  | { type: "image"; imageId: number; caption: string | null };

function parseManualSource(archive: Archive, storyId: number, source: string): ManualBlock[] {
  const db = archive.db;
  const imageRows = db.prepare("SELECT id,slot_no FROM story_images WHERE story_id=?").all(storyId) as any[];
  const images = new Map<number, number>(imageRows.map(x => [Number(x.slot_no), Number(x.id)]));
  const tokenRe = /\[\[P\]\]|\[\[image:(\d+)(?:\|([^\]]+))?\]\]/g;
  const blocks: ManualBlock[] = [];
  let buffer = "";
  let last = 0;

  const flush = () => {
    const text = buffer.trim();
    if (text) blocks.push({ type: "text", text });
    buffer = "";
  };

  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(source)) !== null) {
    buffer += source.slice(last, m.index);
    if (m[0] === "[[P]]") {
      flush();
    } else {
      flush();
      const slot = Number(m[1]);
      const imageId = images.get(slot);
      if (imageId) {
        blocks.push({ type: "image", imageId, caption: m[2]?.trim() || null });
      } else {
        buffer += m[0];
      }
    }
    last = tokenRe.lastIndex;
  }
  buffer += source.slice(last);
  flush();
  return blocks;
}

function applyManualSegments(archive: Archive, storyId: number, source: string) {
  const db = archive.db;
  const tx = db.transaction(() => {
    const story = db.prepare("SELECT id FROM stories WHERE id=?").get(storyId);
    if (!story) throw new Error("story_id 不存在。");

    const blocks = parseManualSource(archive, storyId, source);
    if (!blocks.length) throw new Error("至少保留一个正文段落或图片块。");

    const old = db.prepare("SELECT id,content FROM paragraphs WHERE story_id=?").all(storyId) as any[];
    const pool = new Map<string, number[]>();
    for (const p of old) {
      if (!pool.has(p.content)) pool.set(p.content, []);
      pool.get(p.content)!.push(Number(p.id));
      db.prepare("UPDATE paragraphs SET paragraph_no=? WHERE id=?").run(-Number(p.id), Number(p.id));
    }

    db.prepare("DELETE FROM content_blocks WHERE story_id=?").run(storyId);
    const used = new Set<number>();
    const insertBlock = db.prepare("INSERT INTO content_blocks(story_id,block_no,block_type,paragraph_id,image_id,caption) VALUES(?,?,?,?,?,?)");
    let paragraphNo = 0;
    let blockNo = 0;

    for (const block of blocks) {
      blockNo++;
      if (block.type === "image") {
        insertBlock.run(storyId, blockNo, "image", null, block.imageId, block.caption);
        continue;
      }

      paragraphNo++;
      let paragraphId = pool.get(block.text)?.shift();
      if (paragraphId) {
        db.prepare("UPDATE paragraphs SET paragraph_no=? WHERE id=?").run(paragraphNo, paragraphId);
      } else {
        const r = db.prepare("INSERT INTO paragraphs(story_id,paragraph_no,content) VALUES(?,?,?)").run(storyId, paragraphNo, block.text);
        paragraphId = Number(r.lastInsertRowid);
        db.prepare("INSERT INTO paragraph_fts(rowid,content) VALUES(?,?)").run(paragraphId, block.text);
      }
      used.add(paragraphId);
      insertBlock.run(storyId, blockNo, "text", paragraphId, null, null);
    }

    for (const p of old) {
      if (used.has(Number(p.id))) continue;
      db.prepare("DELETE FROM paragraph_fts WHERE rowid=?").run(Number(p.id));
      db.prepare("DELETE FROM paragraphs WHERE id=?").run(Number(p.id));
    }

    db.prepare("UPDATE stories SET raw_content=?,updated_at=datetime('now') WHERE id=?").run(source, storyId);
    db.prepare("INSERT INTO activities(actor_id,story_id,paragraph_id,action,detail) VALUES(NULL,?,NULL,'manual_segment',?)")
      .run(storyId, JSON.stringify({ paragraph_count: paragraphNo, block_count: blockNo }));

    return { paragraphCount: paragraphNo, blockCount: blockNo };
  });
  return tx();
}

function editorScript() {
  return `<script>
(() => {
  const ta = document.getElementById('segment-source');
  const preview = document.getElementById('segment-preview');
  const count = document.getElementById('segment-count');
  const cut = document.getElementById('cut-here');
  if (!ta || !preview || !count || !cut) return;

  function insertCut() {
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? start;
    const before = ta.value.slice(0, start).replace(/\\s*$/, '');
    const after = ta.value.slice(end).replace(/^\\s*/, '');
    const token = '\\n\\n[[P]]\\n\\n';
    ta.value = before + token + after;
    const pos = before.length + token.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    render();
  }

  function render() {
    const withoutImages = ta.value.replace(/\\[\\[image:\\d+(?:\\|[^\\]]+)?\\]\\]/g, '\\n[图片]\\n');
    const pieces = withoutImages.split('[[P]]').map(x => x.trim()).filter(Boolean);
    count.textContent = String(pieces.length);
    preview.innerHTML = pieces.map((x, i) => '<div class="card"><span class="pill">¶' + (i + 1) + '</span> ' + esc(x.slice(0, 240)) + (x.length > 240 ? '…' : '') + '</div>').join('');
  }

  function esc(s) {
    return String(s || '').replace(/[&<>\"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c] || c));
  }

  cut.addEventListener('click', insertCut);
  ta.addEventListener('input', render);
  render();
})();
</script>`;
}

export function buildSegments(archive: Archive, adminUser?: string, adminPassword?: string) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: true, limit: "12mb" }));
  router.use(auth(adminUser, adminPassword));

  router.get("/segments", (_req, res) => {
    const stories = archive.listStories({ limit: 200 }) as any[];
    res.send(page("手动分段", `<h1>手动分段</h1><p class="meta">这里不猜标题、不看空行。进入一篇以后，你亲自决定哪里是 ¶1、¶2、¶3。</p>` +
      stories.map(s => `<div class="card"><a href="/segments/${s.id}"><b>${esc(s.title)}</b></a><div class="meta">#${s.id} · ${esc(s.category)} · 图片 ${s.image_count}</div></div>`).join("")));
  });

  router.get("/segments/:id", (req, res) => {
    try {
      const storyId = Number(req.params.id);
      const story: any = archive.getStoryForEdit(storyId);
      const source = storySource(archive, storyId);
      res.send(page(`分段：${story.title}`, `<h1>分段：${esc(story.title)}</h1>
        <p class="meta">把光标放到想断开的地方，点“从这里切一段”。页面会插入 <code>[[P]]</code>，这个标记只负责段落边界，不会作为正文显示。想合并两段，直接删掉中间的 <code>[[P]]</code>。</p>
        <div class="toolbar"><button id="cut-here" type="button">✂ 从这里切一段</button><a href="/story/${storyId}">查看文章</a></div>
        <form method="post" action="/segments/${storyId}">
          <textarea id="segment-source" name="source">${esc(source)}</textarea>
          <div class="toolbar"><button type="submit">保存分段</button></div>
        </form>
        <h2>预览 <span class="pill"><span id="segment-count">0</span> 段</span></h2>
        <div id="segment-preview"></div>
        ${editorScript()}`));
    } catch (e: any) {
      res.status(404).send(page("分段失败", `<p>${esc(e?.message || e)}</p>`));
    }
  });

  router.post("/segments/:id", (req, res) => {
    try {
      const storyId = Number(req.params.id);
      const source = String(req.body?.source || "");
      const result = applyManualSegments(archive, storyId, source);
      res.redirect(`/story/${storyId}?segmented=${result.paragraphCount}`);
    } catch (e: any) {
      console.error(`[POST /segments/${req.params.id}]`, e?.stack || e);
      res.status(400).send(page("保存分段失败", `<p>${esc(e?.message || e)}</p><p><a href="/segments/${Number(req.params.id)}">返回</a></p>`));
    }
  });

  return router;
}
