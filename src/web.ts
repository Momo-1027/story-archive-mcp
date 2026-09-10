import express from "express";
import multer from "multer";
import type { Archive } from "./db.js";

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const esc = (x: unknown) => String(x ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;");

function asFiles(files: Express.Multer.File[] | undefined) {
  return (files ?? []).map(file => ({
    originalName: file.originalname,
    mimeType: file.mimetype,
    buffer: file.buffer
  }));
}

export function buildWeb(archive: Archive, adminUser?: string, adminPassword?: string) {
  const app = express();
  app.use(express.urlencoded({ extended: true, limit: "12mb" }));
  app.use(express.json({ limit: "12mb" }));

  app.use((req, res, next) => {
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
  });

  const css = `
  body{font:15px/1.68 system-ui,-apple-system,sans-serif;max-width:1100px;margin:28px auto;padding:0 18px;color:#202124;background:#f7f7f8}
  nav{display:flex;gap:16px;align-items:center;margin:0 0 22px;flex-wrap:wrap}a{color:#4f46e5;text-decoration:none}
  .card{background:#fff;border:1px solid #e3e3e7;border-radius:14px;padding:16px;margin:12px 0}
  .tag{display:inline-block;background:#eeeef5;border-radius:999px;padding:2px 9px;margin:2px;font-size:12px}
  .meta{color:#777;font-size:13px}.comment{margin:9px 0 0 18px;padding:8px 11px;border-left:3px solid #d7d7df;background:#fafafd}
  input,textarea,select{width:100%;box-sizing:border-box;padding:9px;margin:4px 0 12px;border:1px solid #ccc;border-radius:8px}
  button{padding:9px 14px;border:1px solid #bbb;border-radius:8px;background:white;cursor:pointer}
  .danger{color:#b42318}.activity{padding:10px 0;border-bottom:1px solid #e7e7ea}
  .story-image{max-width:100%;height:auto;border-radius:12px;border:1px solid #ddd;display:block}
  .caption{margin-top:8px;color:#555;font-size:14px}.toolbar{display:flex;gap:10px;flex-wrap:wrap}
  pre.hint{white-space:pre-wrap;background:#f4f4f8;border:1px solid #ddd;border-radius:10px;padding:12px}
  `;
  const layout = (title: string, body: string) => `<!doctype html><html lang=zh-CN><head><meta charset=utf-8>
  <meta name=viewport content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body>
  <nav><b>Story Archive</b><a href="/">档案</a><a href="/upload">上传</a><a href="/activity">动态</a><a href="/actors">账号</a><a href="/tags">标签</a></nav>${body}</body></html>`;

  app.get("/", (_req, res) => {
    const xs: any[] = archive.listStories({ limit: 100 });
    res.send(layout("档案", `<h1>档案</h1>` + xs.map(s => `
      <div class=card><a href="/story/${s.id}"><b>${esc(s.title)}</b></a>
      <div class=meta>${esc(s.category)} · ${esc(s.created_at)} · #${s.id} · 图片 ${s.image_count}</div>
      <p>${esc(s.summary || "")}</p>${s.tags.map((t: string) => `<span class=tag>#${esc(t)}</span>`).join("")}</div>`).join("")));
  });

  app.get("/image/:id", (req, res) => {
    try {
      const image = archive.getImageById(Number(req.params.id));
      res.type(image.mime_type || "application/octet-stream");
      res.sendFile(image.abs_path);
    } catch (e: any) {
      res.status(404).send(e.message);
    }
  });

  app.get("/story/:id", (req, res) => {
    try {
      const s: any = archive.getStoryDocument(Number(req.params.id));
      const all: any = archive.readAllBlocks(s.id, true);
      res.send(layout(s.title, `<h1>${esc(s.title)}</h1>
      <div class=toolbar><a href="/story/${s.id}/edit">编辑</a></div>
      <div class=meta>${esc(s.category)} · #${s.id} · 创建 ${esc(s.created_at)} · 更新 ${esc(s.updated_at)}</div>
      <p>${esc(s.summary || "")}</p><p>${s.tags.map((t: string) => `<span class=tag>#${esc(t)}</span>`).join("")}</p>
      <div class=meta>图片占位语法：[[image:1]] 或 [[image:2|这里写说明]]</div>` +
      all.blocks.map((block: any) => block.block_type === "text"
        ? `<div class=card id="p${block.paragraph_no}">
            <div class=meta>¶${block.paragraph_no} · paragraph_id=${block.paragraph_id}</div>
            <p>${esc(block.content).replaceAll("\n", "<br>")}</p>
            ${(block.comments || []).map((c: any) => `<div class=comment><b>${esc(c.actor)}</b>${c.window_label ? ` <span class=meta>(${esc(c.window_label)})</span>` : ""}：${esc(c.body)}
              ${c.reply_to ? `<div class=meta>↳ 回复 @${esc(c.reply_to_actor || "其他账号")} #${c.reply_to}${c.reply_to_body ? `：${esc(String(c.reply_to_body).slice(0,80))}` : ""}</div>` : ""}
              <div class=meta>#${c.comment_id} · ${esc(c.created_at)}</div></div>`).join("")}
          </div>`
        : `<div class=card>
            <div class=meta>🖼 image #${block.image_id} · slot ${block.slot_no} · ${esc(block.original_name)}</div>
            <img class="story-image" src="/image/${block.image_id}" alt="${esc(block.caption || block.original_name || `image-${block.slot_no}`)}">
            ${block.caption ? `<div class=caption>${esc(block.caption)}</div>` : ""}
          </div>`).join("") +
      `<form method="post" action="/story/${s.id}/delete" onsubmit="return confirm('确定删除整篇？')"><button class=danger>删除整篇</button></form>`));
    } catch (e: any) {
      res.status(404).send(layout("不存在", `<p>${esc(e.message)}</p>`));
    }
  });

  app.get("/upload", (_req, res) => res.send(layout("上传", `
    <h1>上传文本 / 图文档案</h1><form method="post" action="/upload" enctype="multipart/form-data">
    <label>标题<input name="title" required></label>
    <label>摘要<input name="summary"></label>
    <label>分类<input name="category" placeholder="AI狼人杀 / 世界盒子 / 小说共读 / 其他"></label>
    <label>标签（逗号分隔）<input name="tags" placeholder="芋圆, 女巫, 盲毒"></label>
    <label>来源备注<input name="source_note" placeholder="例如：2026-08-22 第二局复盘"></label>
    <label>正文 / 图文源码<textarea name="content" rows="20"></textarea></label>
    <label>上传图片（顺序对应 image:1, image:2...）<input type="file" name="images" multiple accept="image/*"></label>
    <pre class="hint">插图写法示例：
[[image:1]]
[[image:2|这张图是角色表]]

说明：
1. 你上传的第1张图对应 [[image:1]]。
2. 第2张图对应 [[image:2]]，以此类推。
3. 纯图片文档也可以，正文留空即可。</pre>
    <button>上传</button></form>`)));

  app.post("/upload", upload.array("images", 30), (req, res) => {
    try {
      const out = archive.uploadStory({
        title: String(req.body.title || ""),
        summary: String(req.body.summary || ""),
        category: String(req.body.category || "其他"),
        sourceNote: String(req.body.source_note || ""),
        tags: String(req.body.tags || "").split(/[,，]/).map((x: string) => x.trim()).filter(Boolean),
        rawContent: String(req.body.content || ""),
        images: asFiles(req.files as Express.Multer.File[] | undefined)
      });
      res.redirect(`/story/${out.story_id}`);
    } catch (e: any) {
      res.status(400).send(layout("上传失败", `<p>${esc(e.message)}</p><p><a href="/upload">返回</a></p>`));
    }
  });

  app.get("/story/:id/edit", (req, res) => {
    try {
      const s: any = archive.getStoryForEdit(Number(req.params.id));
      res.send(layout(`编辑 ${s.title}`, `
        <h1>编辑：${esc(s.title)}</h1>
        <form method="post" action="/story/${s.id}/edit" enctype="multipart/form-data">
          <label>标题<input name="title" required value="${esc(s.title)}"></label>
          <label>摘要<input name="summary" value="${esc(s.summary || "")}"></label>
          <label>分类<input name="category" value="${esc(s.category || "")}"></label>
          <label>标签（逗号分隔）<input name="tags" value="${esc((s.tags || []).join(", "))}"></label>
          <label>来源备注<input name="source_note" value="${esc(s.source_note || "")}"></label>
          <label>正文 / 图文源码<textarea name="content" rows="22">${esc(s.raw_content || "")}</textarea></label>
          <label>新增图片（会追加成新的 image:N 槽位）<input type="file" name="images" multiple accept="image/*"></label>
          <pre class="hint">插图写法：[[image:1]] 或 [[image:2|图片说明]]

当前可用图片槽位：
${(s.images || []).map((img: any) => `image:${img.slot_no} → ${img.original_name}`).join("\n") || "（暂无已上传图片）"}

编辑说明：
1. 新上传图片会自动继续编号。
2. 你可以在正文任意位置插入或移动 [[image:N]]。
3. 暂不单独删除旧图片；如果正文里不引用，它就不会显示在正文中。</pre>
          <button>保存修改</button>
        </form>`));
    } catch (e: any) {
      res.status(404).send(layout("不存在", `<p>${esc(e.message)}</p>`));
    }
  });

  app.post("/story/:id/edit", upload.array("images", 30), (req, res) => {
    try {
      archive.updateStory({
        storyId: Number(req.params.id),
        title: String(req.body.title || ""),
        summary: String(req.body.summary || ""),
        category: String(req.body.category || "其他"),
        sourceNote: String(req.body.source_note || ""),
        tags: String(req.body.tags || "").split(/[,，]/).map((x: string) => x.trim()).filter(Boolean),
        rawContent: String(req.body.content || ""),
        images: asFiles(req.files as Express.Multer.File[] | undefined)
      });
      res.redirect(`/story/${Number(req.params.id)}`);
    } catch (e: any) {
      res.status(400).send(layout("保存失败", `<p>${esc(e.message)}</p><p><a href="/story/${Number(req.params.id)}/edit">返回</a></p>`));
    }
  });

  app.post("/story/:id/delete", (req, res) => {
    archive.deleteStory(Number(req.params.id));
    res.redirect("/");
  });

  app.get("/activity", (_req, res) => {
    const xs: any[] = archive.activityFeed({ limit: 200 });
    res.send(layout("动态", `<h1>动态</h1>` + xs.map(x => `<div class=activity>
      <b>${esc(x.actor || "小酒")}</b>${x.window_label ? ` <span class=meta>(${esc(x.window_label)})</span>` : ""}
      · ${esc(x.action)} ${x.story_id ? `· <a href="/story/${x.story_id}">${esc(x.title)}</a>` : ""} ${x.paragraph_no ? `· ¶${x.paragraph_no}` : ""}
      <div class=meta>${esc(x.detail || "")} · ${esc(x.created_at)}</div></div>`).join("")));
  });

  app.get("/actors", (_req, res) => {
    const xs: any[] = archive.listActors(200);
    res.send(layout("账号", `<h1>窗口账号</h1>` + xs.map(x => `<div class=card><b>${esc(x.display_name)}</b>
      ${x.window_label ? `· ${esc(x.window_label)}` : ""}<div class=meta>actor #${x.id} · 段评 ${x.comments} · 标签故事 ${x.tagged_stories}<br>
      创建 ${esc(x.created_at)} · 最近使用 ${esc(x.last_seen_at)}</div></div>`).join("")));
  });

  app.get("/tags", (_req, res) => {
    const xs: any[] = archive.listTags(300);
    res.send(layout("标签", `<h1>标签</h1>` + xs.map(x => `<span class=tag>#${esc(x.name)} (${x.story_count})</span>`).join(" ")));
  });

  return app;
}
