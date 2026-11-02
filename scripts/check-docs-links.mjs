#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PUNCTUATION = /[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@\[\]^`{|}~]/g;

function slugify(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(PUNCTUATION, '')
    .replace(/\s/g, '-');
}

async function collectMarkdown(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectMarkdown(path)));
    else if (entry.isFile() && extname(entry.name) === '.md') files.push(path);
  }
  return files;
}

function anchorsFor(content) {
  const anchors = new Set();
  const counts = new Map();
  let inFence = false;
  for (const line of content.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    const base = slugify(match[2]);
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    anchors.add(seen === 0 ? base : `${base}-${seen}`);
  }
  return anchors;
}

function linksIn(content) {
  const links = [];
  let inFence = false;
  content.split('\n').forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const pattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match;
    while ((match = pattern.exec(line))) {
      links.push({ target: match[1], line: index + 1 });
    }
  });
  return links;
}

async function main() {
  const files = [join(root, 'README.md'), ...(await collectMarkdown(join(root, 'docs')))];
  const anchorCache = new Map();
  const broken = [];

  for (const file of files) {
    const content = await readFile(file, 'utf8');
    for (const { target, line } of linksIn(content)) {
      if (/^(https?:|mailto:|tel:)/.test(target)) continue;
      const [rawPath, rawAnchor] = target.split('#');
      const path = decodeURIComponent(rawPath);
      const anchor = rawAnchor ? decodeURIComponent(rawAnchor) : '';

      const destination = path ? resolve(dirname(file), path) : file;
      let destinationStat;
      try {
        destinationStat = await stat(destination);
      } catch {
        broken.push({ file, line, target, reason: `missing file: ${relative(root, destination)}` });
        continue;
      }

      if (!anchor || !destinationStat.isFile()) continue;
      if (extname(destination) !== '.md') continue;

      let anchors = anchorCache.get(destination);
      if (!anchors) {
        anchors = anchorsFor(await readFile(destination, 'utf8'));
        anchorCache.set(destination, anchors);
      }
      if (!anchors.has(anchor)) {
        broken.push({ file, line, target, reason: `missing anchor: #${anchor}` });
      }
    }
  }

  if (broken.length === 0) {
    console.log(`Documentation links OK (${files.length} files checked).`);
    return;
  }

  for (const item of broken) {
    console.error(`${relative(root, item.file)}:${item.line} -> ${item.target} (${item.reason})`);
  }
  console.error(`\n${broken.length} broken link(s).`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
