import express from "express";

/**
 * Adds discoverable links to the manual segmentation editor without coupling
 * the main archive renderer to the segmentation router.
 */
export function segmentLinks() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const originalSend = res.send.bind(res);

    (res as any).send = (body: any) => {
      if (typeof body === "string" && body.includes("<nav><b>Story Archive</b>")) {
        if (!body.includes('href="/segments">分段</a>')) {
          body = body.replace(
            '<a href="/upload">上传</a>',
            '<a href="/upload">上传</a><a href="/segments">分段</a>'
          );
        }

        const match = req.path.match(/^\/story\/(\d+)(?:\/edit)?$/);
        if (match) {
          const storyId = match[1];
          const link = `<a href="/segments/${storyId}">✂ 手动分段</a>`;
          if (!body.includes(`href="/segments/${storyId}"`)) {
            if (req.path.endsWith("/edit")) {
              body = body.replace(
                /(<h1>编辑：[^<]*<\/h1>)/,
                `$1<div class="toolbar">${link}</div>`
              );
            } else {
              body = body.replace(
                '<div class=toolbar>',
                `<div class=toolbar>${link}`
              );
            }
          }
        }
      }
      return originalSend(body);
    };

    next();
  };
}
