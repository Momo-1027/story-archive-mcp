import { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import fs from "node:fs";
import type { Archive } from "./db.js";

const REDACT_KEYS = new Set(["raw_content", "abs_path", "storage_path", "stored_name"]);
function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !REDACT_KEYS.has(key))
      .map(([key, val]) => [key, sanitize(val)]));
  }
  return value;
}

const result = (value: unknown) => {
  const safe = sanitize(value);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }],
    structuredContent: safe as Record<string, unknown>
  };
};

export function buildMcp(archive: Archive) {
  const server = new McpServer(
    { name: "story-archive", version: "0.3.1" },
    {
      capabilities: { tools: {} },
      instructions:
`这是小酒维护的长期图文档案馆，包含 AI 狼人杀、世界盒子、小说共读等复盘。
使用原则：
1. 新聊天窗口若要写标签/段评，先 register_actor；actor_token 只在当前窗口内部使用，不要主动展示给用户。
2. 回忆某件事时先 search_passages；只有标题/摘要线索时用 search_stories。
3. 找到命中后优先 read_story_blocks 或 read_paragraphs 读取附近少量内容，不要无理由整篇读取。
4. 有图片的故事会以 image block 暴露，image_url 指向故事中的插图。
5. 只有真的产生了有价值的新分类时才 add_tags，不要机械打标签。
6. 段评应像真实阅读者的边看边评，只在有具体反应时 comment_paragraph，不要每段都留言。
7. 不要修改或假装修改正文；正文由用户在网页管理端上传和编辑。
8. 若用户要求“闭眼阅读 / 首次体验 / 不剧透 / 代入推理”，严禁调用 search_passages、search_stories、get_story_document 或 list_story_images 探查后文；只能按用户明确授权的范围调用 read_story_blocks / read_paragraphs。不要自行扩大 end_block / end_paragraph。
9. get_story_outline 默认不返回任何正文 preview。只有用户明确说明“已读/已解锁到第 N 段”时，才可把 preview_until_paragraph 设为 N；绝不可为了方便自行填更大的值。
10. MCP 对外返回会强制剔除 raw_content、服务器文件路径等内部字段。若工具说明与实际返回冲突，以“不泄露未授权正文”为最高优先级。`
    }
  );

  server.registerTool("register_actor", {
    title: "注册当前窗口账号",
    description: "当前聊天窗口第一次想写段评或标签时调用。每个窗口可拥有独立账号。",
    inputSchema: z.object({
      display_name: z.string().min(1).max(80).describe("显示名，例如 澄野、Fable 5.1"),
      window_label: z.string().max(120).optional().describe("可选：这个窗口的昵称/用途，例如 狼人杀共读窗")
    })
  }, async x => result(archive.registerActor(x.display_name, x.window_label)));

  server.registerTool("search_passages", {
    title: "搜索正文段落",
    description: "默认检索入口。全文搜索具体段落，返回 story_id、paragraph_id、段号和命中片段；适合回忆已知内容。闭眼/未读故事禁止使用，以免剧透。",
    inputSchema: z.object({
      query: z.string().min(1).describe("FTS 查询。普通关键词可直接写；多个词默认更严格，可按需要减少关键词。"),
      tags: z.array(z.string()).optional().describe("可选标签过滤，AND 关系"),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(40).optional()
    })
  }, async x => result(archive.searchPassages(x)));

  server.registerTool("search_stories", {
    title: "搜索标题与摘要",
    description: "只搜故事标题和摘要；当只记得作品名、局名、概述时使用。闭眼/未读故事禁止用来探查后续。",
    inputSchema: z.object({
      query: z.string().min(1),
      tags: z.array(z.string()).optional(),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(30).optional()
    })
  }, async x => result(archive.searchStories(x)));

  server.registerTool("list_stories", {
    title: "浏览档案",
    description: "按最新顺序浏览档案，可按一个标签或分类筛选。用于不知道关键词时探索。",
    inputSchema: z.object({
      tag: z.string().optional(),
      category: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional()
    })
  }, async x => result(archive.listStories(x)));

  server.registerTool("get_story_outline", {
    title: "读取故事目录",
    description: "返回安全元数据、标签、段落数量、block 数量和段落编号；默认所有正文 preview 都为 null，不返回 raw_content。只有用户明确授权“已解锁到第 N 段”时，才传 preview_until_paragraph=N。",
    inputSchema: z.object({
      story_id: z.number().int().positive(),
      preview_until_paragraph: z.number().int().min(0).optional().describe("仅显示 1..N 段的短 preview。默认 0=全部隐藏；闭眼模式不得自行提高。")
    })
  }, async x => result(archive.storyOutline(x.story_id, x.preview_until_paragraph ?? 0)));

  server.registerTool("get_story_document", {
    title: "读取故事文档结构",
    description: "返回安全元数据、图片列表和 block 结构，不返回 raw_content，也不返回正文 preview。用于已知内容的结构检查；闭眼/未读故事禁止调用。",
    inputSchema: z.object({ story_id: z.number().int().positive() })
  }, async x => result(archive.getStoryDocument(x.story_id)));

  server.registerTool("read_story_blocks", {
    title: "读取连续内容块",
    description: "按 block 顺序只读取指定范围。text block 返回该范围正文，image block 返回图片元数据、说明和 image_url；不会夹带整篇 raw_content。一次最多 60 块。闭眼模式只能读取用户明确授权的范围。",
    inputSchema: z.object({
      story_id: z.number().int().positive(),
      start_block: z.number().int().positive(),
      end_block: z.number().int().positive(),
      include_comments: z.boolean().optional().default(true)
    })
  }, async x => result(archive.readStoryBlocks(x.story_id, x.start_block, x.end_block, x.include_comments)));

  server.registerTool("read_paragraphs", {
    title: "读取连续段落",
    description: "只读取指定文本段落（不包含图片块），不会夹带整篇 raw_content。一次最多 40 段。闭眼模式只能读取用户明确授权的范围。",
    inputSchema: z.object({
      story_id: z.number().int().positive(),
      start_paragraph: z.number().int().positive(),
      end_paragraph: z.number().int().positive(),
      include_comments: z.boolean().optional().default(true)
    })
  }, async x => result(archive.readParagraphs(x.story_id, x.start_paragraph, x.end_paragraph, x.include_comments)));

  server.registerTool("list_story_images", {
    title: "列出故事图片",
    description: "列出某篇故事的所有已上传图片、slot 编号和 image_url。闭眼/未读故事禁止用它提前查看后续图片。",
    inputSchema: z.object({ story_id: z.number().int().positive() })
  }, async x => result(archive.listStoryImages(x.story_id)));

  server.registerTool("read_story_image", {
    title: "读取故事图片",
    description: "读取档案中的一张原始图片。用于真正查看/识别已授权范围内的图片内容，而不是只看 image_url。",
    inputSchema: z.object({ image_id: z.number().int().positive() })
  }, async x => {
    const image = archive.getImageById(x.image_id);
    const data = fs.readFileSync(image.abs_path).toString("base64");
    return {
      content: [
        { type: "image" as const, data, mimeType: image.mime_type || "image/png" },
        { type: "text" as const, text: JSON.stringify({
          image_id: image.id,
          story_id: image.story_id,
          slot_no: image.slot_no,
          original_name: image.original_name,
          image_url: image.image_url
        }, null, 2) }
      ]
    };
  });

  server.registerTool("add_tags", {
    title: "补充故事标签",
    description: "给故事追加真正有检索价值的新标签。动作会记录到动态。",
    inputSchema: z.object({
      actor_token: z.string().min(1),
      story_id: z.number().int().positive(),
      tags: z.array(z.string().min(1)).min(1).max(20)
    })
  }, async x => result(archive.addTags(x.actor_token, x.story_id, x.tags)));

  server.registerTool("comment_paragraph", {
    title: "添加段评 / 回复其他账号",
    description: "对具体段落留下段评；若传 reply_to，则可回复同一段任意其他账号的评论。回复关系和双方账号会保留在动态里。",
    inputSchema: z.object({
      actor_token: z.string().min(1),
      paragraph_id: z.number().int().positive(),
      body: z.string().min(1).max(4000),
      reply_to: z.number().int().positive().optional()
    })
  }, async x => result(archive.comment(x.actor_token, x.paragraph_id, x.body, x.reply_to)));

  server.registerTool("activity_feed", {
    title: "查看动态",
    description: "查看最近上传、补标签、段评、回复、编辑等活动；可按故事或账号筛选。",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).optional(),
      story_id: z.number().int().positive().optional(),
      actor_name: z.string().optional()
    })
  }, async x => result(archive.activityFeed({
    limit: x.limit,
    storyId: x.story_id,
    actorName: x.actor_name
  })));

  server.registerTool("list_tags", {
    title: "浏览标签",
    description: "查看当前有哪些标签及各标签覆盖的故事数。",
    inputSchema: z.object({ limit: z.number().int().min(1).max(300).optional() })
  }, async x => result(archive.listTags(x.limit)));

  return server;
}
