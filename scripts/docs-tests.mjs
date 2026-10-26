import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Window } from "happy-dom";
import { createMarkdownRenderer } from "vitepress";
import pkg from "../package.json" with { type: "json" };
import config from "../docs/.vitepress/config.mts";
import {
  documentationVersion,
  documentationVersionPlugin,
  replaceVersionPlaceholder,
} from "../docs/.vitepress/version.ts";

const docsDirectory = new URL("../docs", import.meta.url).pathname;

async function collectMarkdownFiles(directory) {
  const files = [];

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownFiles(path)));
    } else if (entry.name.endsWith(".md")) {
      files.push(path);
    }
  }

  return files;
}

function installBrowserGlobals() {
  const window = new Window();
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.navigator = window.navigator;
  globalThis.Element = window.Element;
  globalThis.HTMLElement = window.HTMLElement;
  globalThis.SVGElement = window.SVGElement;
}

async function testMermaidDiagrams() {
  installBrowserGlobals();
  const { default: mermaid } = await import("mermaid");
  const files = await collectMarkdownFiles(docsDirectory);
  let diagramCount = 0;

  for (const file of files) {
    const markdown = await readFile(file, "utf8");
    const diagrams = markdown.matchAll(/```mermaid\s*\n([\s\S]*?)```/g);

    for (const [index, match] of Array.from(diagrams).entries()) {
      await assert.doesNotReject(
        mermaid.parse(match[1]),
        `${relative(docsDirectory, file)} diagram ${index + 1} must contain valid Mermaid syntax`,
      );
      diagramCount += 1;
    }
  }

  assert(diagramCount > 0, "The documentation must contain a Mermaid diagram.");
  console.log(`Validated ${diagramCount} Mermaid diagrams.`);
}

async function testMermaidViewer() {
  const markdown = await createMarkdownRenderer("docs", config.markdown);
  const rendered = await markdown.render(`\`\`\`mermaid
graph TD
  A --> B
\`\`\``);

  assert(
    rendered.includes("<Mermaid"),
    `Mermaid fences must use the interactive viewer component. Received:\n${rendered}`,
  );
  assert(
    !rendered.includes('data-processed="false"'),
    "Mermaid fences must not use the legacy static renderer.",
  );
  console.log("Mermaid fences use the interactive zoom viewer.");
}

async function testImageViewer() {
  const markdown = await createMarkdownRenderer("docs", config.markdown);
  const rendered = await markdown.render("![A screenshot](./shot.png)");

  assert(
    /<ImageViewer alt="A screenshot"><img [^>]*alt="A screenshot"[^>]*><\/ImageViewer>/.test(
      rendered,
    ),
    `Images must open in the full-size viewer. Received:\n${rendered}`,
  );
  console.log("Images open in the full-size viewer.");
}

async function testDocumentationVersion() {
  assert.equal(documentationVersion, pkg.version);

  const source = `---
description: "Dopbase {{version}} documentation."
---

# Available in {{version}}

Dopbase v{{version}} is installed.

\`\`\`text
Version {{version}}
\`\`\`
`;

  const plugin = documentationVersionPlugin();
  assert.equal(typeof plugin.transform, "function");

  const result = plugin.transform(source, "/docs/version-check.md?test");
  assert(result && typeof result === "object" && "code" in result);
  assert(!result.code.includes("{{version}}"));
  assert(result.code.includes(`Dopbase v${pkg.version} is installed.`));
  assert.equal(plugin.transform(source, "/docs/version-check.vue"), null);

  const env = {};
  const markdown = await createMarkdownRenderer("docs", config.markdown);
  const rendered = await markdown.render(result.code, env);

  assert.equal(
    env.frontmatter.description,
    `Dopbase ${pkg.version} documentation.`,
  );
  assert(rendered.includes(`Available in ${pkg.version}`));
  assert(rendered.includes(`Dopbase v${pkg.version} is installed.`));
  assert(rendered.includes(`Version ${pkg.version}`));
  console.log(`Documentation placeholders resolve to ${pkg.version}.`);
}

async function testPageMetadata() {
  const markdown = await createMarkdownRenderer("docs", config.markdown);
  const files = await collectMarkdownFiles(docsDirectory);
  const titles = new Map();
  const descriptions = new Map();

  for (const file of files) {
    const page = relative(docsDirectory, file);
    const env = {};
    await markdown.render(
      replaceVersionPlaceholder(await readFile(file, "utf8")),
      env,
    );
    const { title, description, titleTemplate } = env.frontmatter ?? {};

    assert(title, `${page} must set a title in its frontmatter`);
    const fullTitle = titleTemplate === false ? title : `${title} · Dopbase`;
    assert(
      fullTitle.length <= 60,
      `${page} title is ${fullTitle.length} characters; keep it within 60`,
    );
    assert(
      description?.length >= 100 && description.length <= 160,
      `${page} description is ${description?.length ?? 0} characters; use 100 to 160`,
    );
    assert(
      !titles.has(title),
      `${page} repeats the title of ${titles.get(title)}`,
    );
    assert(
      !descriptions.has(description),
      `${page} repeats the description of ${descriptions.get(description)}`,
    );
    titles.set(title, page);
    descriptions.set(description, page);
  }

  console.log(`Checked titles and descriptions of ${files.length} pages.`);
}

async function testHeadTags() {
  const transform = (pageData, title) =>
    config.transformHead({ pageData, title, head: [] });
  const meta = (head, key) =>
    head.find(
      ([tag, attrs]) =>
        tag === "meta" && (attrs.property === key || attrs.name === key),
    )?.[1].content;

  const head = await transform(
    {
      relativePath: "guide/quick-start.md",
      title: "Quick start",
      frontmatter: { description: "Install Dopbase." },
      lastUpdated: Date.UTC(2026, 9, 26),
    },
    "Quick start · Dopbase",
  );
  assert.equal(meta(head, "og:locale"), "en_US");
  assert.equal(meta(head, "og:title"), "Quick start · Dopbase");
  assert.equal(meta(head, "twitter:title"), "Quick start · Dopbase");
  assert.equal(meta(head, "article:modified_time"), "2026-10-26T00:00:00.000Z");

  const jsonLd = JSON.parse(
    head.find(([, attrs]) => attrs.type === "application/ld+json")[2],
  );
  const [article, breadcrumbs] = jsonLd["@graph"];
  assert.equal(article.dateModified, "2026-10-26T00:00:00.000Z");
  assert.deepEqual(
    breadcrumbs.itemListElement.map((item) => item.name),
    ["Docs", "Guide", "Quick start"],
  );

  const home = await transform(
    { relativePath: "index.md", title: "Dopbase", frontmatter: {} },
    "Dopbase",
  );
  const homeJsonLd = JSON.parse(
    home.find(([, attrs]) => attrs.type === "application/ld+json")[2],
  );
  assert.equal(homeJsonLd["@graph"][1].softwareVersion, pkg.version);

  const notFound = await transform(
    { relativePath: "404.md", isNotFound: true, title: "404", frontmatter: {} },
    "404 · Dopbase",
  );
  assert.deepEqual(notFound, [
    ["meta", { name: "robots", content: "noindex" }],
  ]);
  console.log("Head tags carry branded titles, dates, and breadcrumbs.");
}

await testMermaidDiagrams();
await testMermaidViewer();
await testImageViewer();
await testDocumentationVersion();
await testPageMetadata();
await testHeadTags();
