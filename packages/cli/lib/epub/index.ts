import * as mdit from 'markdown-it';
import { readFileSync, readdirSync, writeFileSync } from 'fs';
import { join, basename as pathBasename } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import * as JSZip from 'jszip';
import { stripFrontmatter } from '../utils/frontmatter.util';

interface Chapter {
  path: string;
  xhtmlPath: string;
  title?: string;
}

export interface BookMetadata {
  title: string;
  author: string;
  language: string;
  cover_image: string;
  description: string;
  tags?: string[];
  source?: string;
  status?: string;
  modified?: string;
}

interface BookOptions {
  author?: string;
  cover?: string;
  description?: string;
  language?: string;
  title?: string;
  tags?: string[];
  verbose?: boolean;
}

interface MakeBookParams {
  workingDirectory: string;
  ignoredFiles: string[];
  outputPath: string;
}

const home = homedir();
const chapters: Chapter[] = [];
const fileNames: string[] = [];
const images: string[] = [];

let metadata: BookMetadata = {} as BookMetadata;
let date = new Date().toISOString();
let uuid = randomUUID();

const md = mdit({
  xhtmlOut: true,
});
const zip = new JSZip();

const defaultConfig = {
  defaultCover: 'cover.jpg',
  defaultTitle: 'Unknown',
};

const config = getConfig();

const options = {
  author: config.defaultAuthor,
  cover: config.defaultCover,
  description: config.defaultDescription,
  language: config.defaultLanguage,
  title: config.defaultTitle,
  tags: config.defaultTags,
  verbose: !!config.defaultVerbose,
  bookDirectory: process.cwd(),
};

function basename(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

function extension(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('.') + 1);
}

function processMarkdown(file: string, files: string[]) {
  const image = file.slice(0, -3);
  let content = readFileSync(join(options.bookDirectory, file)).toString();
  content = stripFrontmatter(content);
  const match = content.match(/^#\s+(.*)/m);
  const title = match ? match[1] : undefined;
  if (files.includes(image + '.jpg')) {
    if (content.indexOf(image + '.jpg') === -1) {
      content = '![](' + image + '.jpg)\n' + content;
    }
  } else if (files.includes(image + '.jpeg')) {
    if (content.indexOf(image + '.jpeg') === -1) {
      content = '![](' + image + '.jpeg)\n' + content;
    }
  } else if (files.includes(image + '.png')) {
    if (content.indexOf(image + '.png') === -1) {
      content = '![](' + image + '.png)\n' + content;
    }
  } else if (files.includes(image + '.gif')) {
    if (content.indexOf(image + '.gif') === -1) {
      content = '![](' + image + '.gif)\n' + content;
    }
  }
  const html = md.render(content);
  const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${metadata.language}">
<head>
<meta charset="utf-8" />
<meta name="generator" content="genepub" />
<title>${file}</title>
<link rel="stylesheet" type="text/css" href="stylesheet.css" />
</head>
<body epub:type="bodymatter">
${html}
</body>
</html>`;
  const xhtmlPath = 'EPUB/' + file.slice(0, -3) + '.xhtml';
  zip.file(xhtmlPath, xhtml);
  chapters.push({
    path: file,
    xhtmlPath: xhtmlPath,
    title: title,
  });
  fileNames.push(xhtmlPath);
}

function processImage(file: string) {
  const content = readFileSync(join(options.bookDirectory, file));
  zip.file('EPUB/' + file, content);
  fileNames.push('EPUB/' + file);
  images.push('EPUB/' + file);
}

function addContainerXml() {
  const container = `<?xml version="1.0" encoding="UTF-8"?>
  <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
    <rootfiles>
      <rootfile full-path="EPUB/content.opf" media-type="application/oebps-package+xml" />
    </rootfiles>
  </container>`;
  zip.file('META-INF/container.xml', container);
}

function addContentOpf() {
  let content = `<?xml version="1.0" encoding="UTF-8"?>
  <package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="epub-id" prefix="ibooks: http://vocabulary.itunes.apple.com/rdf/ibooks/vocabulary-extensions-1.0/">
    <metadata xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:ofp="http://www.idpf.org/2007/opf">
      <dc:title id="epub-title-1">${metadata.title}</dc:title>
      <dc:creator id="id">${metadata.author}</dc:creator>
      <dc:identifier id="epub-id">uuid:${uuid}</dc:identifier>
      <dc:language>${metadata.language}</dc:language>
      <dc:date>${date}</dc:date>
      <dc:description>${metadata.description}</dc:description>`;
  if (metadata.tags) {
    metadata.tags.forEach((tag) => {
      content += `
      <dc:subject>${tag}</dc:subject>`;
    });
  }
  content += `
      <meta name="cover" content="cover_jpg"/>
    </metadata>
    <manifest>
      <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
      <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
      <item id="stylesheet" href="stylesheet.css" media-type="text/css" />
      <item id="cover_xhtml" href="cover.xhtml" media-type="application/xhtml+xml" properties="svg" />
      <item id="title_page_xhtml" href="title_page.xhtml" media-type="application/xhtml+xml" />
`;

  chapters.forEach((chapter) => {
    content +=
      '      <item id="' +
      basename(chapter.xhtmlPath).replace(/\./g, '_') +
      '" href="' +
      basename(chapter.xhtmlPath) +
      '" media-type="application/xhtml+xml" />\n';
  });

  images.forEach((image) => {
    const mimeTypes = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
    };
    content +=
      '      <item id="' +
      basename(image).replace(/\./g, '_') +
      '" href="' +
      basename(image) +
      '" media-type="' +
      mimeTypes[extension(image) as keyof typeof mimeTypes] +
      '" />\n';
  });

  content += '  </manifest>\n';
  content += '  <spine toc="ncx">\n';
  content += '    <itemref idref="cover_xhtml" />\n';
  content += '    <itemref idref="title_page_xhtml" linear="yes" />\n';
  content += '    <itemref idref="nav" />\n';
  chapters.forEach((chapter) => {
    content +=
      '    <itemref idref="' +
      basename(chapter.xhtmlPath).replace(/\./g, '_') +
      '" />\n';
  });
  content += '  </spine>\n';
  content += '  <guide>\n';
  content +=
    '    <reference type="toc" title="' +
    metadata.title +
    '" href="nav.xhtml" />\n';
  content +=
    '    <reference type="cover" title="Cover" href="cover.xhtml" />\n';
  content += '  </guide>\n';
  content += '</package>\n';

  zip.file('EPUB/content.opf', content);
}

function addNavXhtml() {
  let nav = '<?xml version="1.0" encoding="UTF-8"?>\n';
  nav += '<!DOCTYPE html>\n';
  nav +=
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="' +
    metadata.language +
    '">\n';
  nav += '<head>\n';
  nav += '  <meta charset="utf-8" />\n';
  nav += '  <meta name="generator" content="genepub" />\n';
  nav += '  <title>' + metadata.title + '</title>\n';
  nav += '  <link rel="stylesheet" type="text/css" href="stylesheet.css" />\n';
  nav += '</head>\n';
  nav += '<body>\n';
  nav += '<nav epub:type="toc" id="nav">\n';
  nav += '<h1 id="toc">Table of Contents</h1>\n';
  nav += '<p id="toc-title">Title: ' + metadata.title + '</p>\n';
  nav += '<ol class="toc">\n';
  nav += '  <li id="toc-li-cover"><a href="cover.xhtml">Cover</a></li>\n';
  nav += '  <li id="toc-li-title"><a href="title_page.xhtml">Title</a></li>\n';
  nav += '  <li id="toc-li-nav"><a href="nav.xhtml">TOC</a></li>\n';
  chapters.forEach((chapter, i) => {
    nav +=
      '  <li id="toc-li-' +
      i +
      '"><a href="' +
      basename(chapter.xhtmlPath) +
      '">' +
      basename(chapter.xhtmlPath).slice(0, -6) +
      (chapter.title ? ' - ' + chapter.title : '') +
      '</a></li>\n';
  });
  nav += '</ol>\n';
  nav += '</nav>\n';
  nav += '<nav epub:type="landmarks" id="landmarks" hidden="hidden">\n';
  nav += '  <ol>\n';
  nav += '    <li>\n';
  nav += '      <a href="cover.xhtml" epub:type="cover">Cover</a>\n';
  nav += '    </li>\n';
  nav += '    <li>\n';
  nav += '      <a href="#toc" epub:type="toc">Table of Contents</a>\n';
  nav += '    </li>\n';
  nav += '  </ol>\n';
  nav += '</nav>\n';
  nav += '</body>\n';
  nav += '</html>\n';

  zip.file('EPUB/nav.xhtml', nav);
}

function addCoverXhtml() {
  let cover = '<?xml version="1.0" encoding="UTF-8"?>\n';
  cover += '<!DOCTYPE html>\n';
  cover +=
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="' +
    metadata.language +
    '">\n';
  cover += '<head>\n';
  cover += '  <meta charset="utf-8" />\n';
  cover += '  <meta name="generator" content="genepub" />\n';
  cover += '  <title>' + metadata.title + '</title>\n';
  cover +=
    '  <link rel="stylesheet" type="text/css" href="stylesheet.css" />\n';
  cover += '</head>\n';
  cover += '<body id="cover">\n';
  cover += '<div id="cover-image">\n';
  cover +=
    '<img width="400" height="600" src="' + metadata.cover_image + '" />\n';
  cover += '</div>\n';
  cover += '</body>\n';
  cover += '</html>\n';

  zip.file('EPUB/cover.xhtml', cover);
}

function addTitlePageXhtml() {
  const location = options.bookDirectory.replace(home, '');
  let title_page = '<?xml version="1.0" encoding="UTF-8"?>\n';
  title_page += '<!DOCTYPE html>\n';
  title_page +=
    '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="' +
    metadata.language +
    '">\n';
  title_page += '<head>\n';
  title_page += '  <meta charset="utf-8" />\n';
  title_page += '  <meta name="generator" content="genepub" />\n';
  title_page += '  <title>' + metadata.title + '</title>\n';
  title_page +=
    '  <link rel="stylesheet" type="text/css" href="stylesheet.css" />\n';
  title_page += '</head>\n';
  title_page += '<body epub:type="frontmatter">\n';
  title_page += '<section epub:type="titlepage" class="titlepage">\n';
  title_page += '  <h1 class="title">' + metadata.title + '</h1>\n';
  title_page += '<table>\n';
  title_page += '<tr><td>Title:</td><td>' + metadata.title + '</td></tr>\n';
  title_page += '<tr><td>Author:</td><td>' + metadata.author + '</td></tr>\n';
  title_page += '<tr><td>Loc:</td><td>' + location + '</td></tr>\n';
  if (metadata.source) {
    title_page +=
      '<tr><td>Source:</td><td><a href="' +
      metadata.source +
      '">' +
      metadata.source +
      '</a></td></tr>\n';
  }
  if (metadata.status) {
    title_page += '<tr><td>Status:</td><td>' + metadata.status + '</td></tr>\n';
  }
  if (metadata.modified) {
    title_page +=
      '<tr><td>Modified:</td><td>' + metadata.modified + '</td></tr>\n';
  }
  title_page += '<tr><td>Gen:</td><td>' + date + '</td></tr>\n';
  title_page += '</table>\n';
  title_page += '<p>' + metadata.description + '</p>\n';
  title_page += '</section>\n';
  title_page += '</body>\n';
  title_page += '</html>\n';

  zip.file('EPUB/title_page.xhtml', title_page);
}

function addTocNcx() {
  let toc = '<?xml version="1.0" encoding="UTF-8"?>\n';
  toc +=
    '<ncx version="2005-1" xmlns="http://www.daisy.org/z3986/2005/ncx/">\n';
  toc += '  <head>\n';
  toc += '    <meta name="dtb:uid" content="uuid:' + uuid + '" />\n';
  toc += '    <meta name="dtb:depth" content="1" />\n';
  toc += '    <meta name="dtb:totalPageCount" content="0" />\n';
  toc += '    <meta name="dtb:maxPageNumber" content="0" />\n';
  toc += '    <meta name="cover" content="cover_jpg" />\n';
  toc += '  </head>\n';
  toc += '  <docTitle>\n';
  toc += '    <text>女友</text>\n';
  toc += '  </docTitle>\n';
  toc += '  <navMap>\n';
  chapters.forEach((chapter, i) => {
    toc += '    <navPoint id="navPoint-' + i + '">\n';
    toc += '      <navLabel>\n';
    toc +=
      '        <text>' +
      basename(chapter.xhtmlPath).slice(0, -6) +
      (chapter.title ? ' - ' + chapter.title : '') +
      '</text>\n';
    toc += '      </navLabel>\n';
    toc += '      <content src="' + basename(chapter.xhtmlPath) + '" />\n';
    toc += '    </navPoint>\n';
  });

  toc += '  </navMap>\n';
  toc += '</ncx>\n';

  zip.file('EPUB/toc.ncx', toc);
}

function addStylesheet() {
  const stylesheet = `
body { font-size: 2em; }
h1 { font-size: 1.4em; }
h2 { font-size: 1.2em; }
h3 { font-size: 1em; }
h4 { font-size: 0.9em; }
h5 { font-size: 0.8em; }
h6 { font-size: 0.7em; }
`;
  zip.file('EPUB/stylesheet.css', stylesheet);
}

function isCJK(c: string): boolean {
  if (typeof c !== 'string') return false;
  const cc = c.charCodeAt(0);
  return !(
    cc !== 0x25cb &&
    (cc < 0x3400 || 0x9fff < cc) &&
    (cc < 0xf900 || 0xfaff < cc) &&
    (cc < 0xff21 || 0xff3a < cc) &&
    (cc < 0xff41 || 0xff5a < cc)
  );
}

function getConfig(): any {
  const config = defaultConfig;
  [
    '/etc/md2epub.json',
    join(home, '.md2epub.json'),
    join(home, '.config', 'md2epub.json'),
  ].forEach((configPath) => {
    try {
      const conf = JSON.parse(readFileSync(configPath, 'utf8'));
      Object.assign(config, conf);
    } catch (e) {
      if (e.code !== 'ENOENT') console.log(configPath, e);
    }
  });
  return config;
}

function usage(optionsConfig: any): string {
  const name = pathBasename(process.argv[1]);
  let usage = 'Usage: ' + name + ' [OPTIONS]\n';
  let maxOptionLength = 0;
  Object.keys(optionsConfig.options).forEach((key) => {
    if (key.length > maxOptionLength) maxOptionLength = key.length;
  });
  Object.keys(optionsConfig.options).forEach((key) => {
    const opt = optionsConfig.options[key];
    let option =
      '  ' +
      '--' +
      key +
      (opt.type === 'string' ? '=ARG' : '') +
      (opt.multiple ? '*' : '');
    if (opt.short) {
      option += ',';
      option = option.padEnd(maxOptionLength + 12, ' ');
      option += '-' + opt.short;
    }
    if (opt.default) {
      option = option.padEnd(maxOptionLength + 16, ' ');
      option +=
        ' (default: ' +
        (opt.multiple ? opt.default.join(',') : opt.default) +
        ')';
    }
    if (opt.description) {
      option += '\n      ' + opt.description;
    }
    usage += option + '\n\n';
  });
  return usage;
}

export function makeBook(
  { workingDirectory, ignoredFiles, outputPath }: MakeBookParams,
  opts: Partial<BookOptions> = {},
) {
  Object.assign(options, opts);
  options.bookDirectory = workingDirectory;
  date = new Date().toISOString();
  uuid = randomUUID();

  const files = readdirSync(options.bookDirectory);

  metadata = {
    title: options.title,
    author: options.author,
    language: options.language,
    cover_image: options.cover,
    description: options.description,
    tags: options.tags,
    source: '',
    status: '',
    modified: '',
  };

  /**
   * By default, markdown-it renders newlines ('\n') in the output for each
   * newline in the input that forms a paragraph (i.e. a softbreak). But for
   * Chinese the newlines that break up a paragraph typically should not be
   * rendered as a space or newline. Therefore, customize the softbreak
   * function if the language is CN.
   *
   * See: https://talk.commonmark.org/t/soft-line-breaks-should-not-introduce-spaces/285/4
   */
  if (metadata.language === 'CN') {
    md.renderer.rules.softbreak = function (
      tokens: any,
      idx: number,
      options: any /*, env */,
    ) {
      if (
        idx > 0 &&
        tokens[idx - 1].type === 'text' &&
        isCJK(tokens[idx - 1].content.slice(-1)) &&
        idx < tokens.length &&
        tokens[idx + 1].type === 'text' &&
        isCJK(tokens[idx + 1].content.slice(0, 1))
      ) {
        return '';
      } else {
        // The default function from markdown-it/lib/renderer.js
        return options.breaks
          ? options.xhtmlOut
            ? '<br />\n'
            : '<br>\n'
          : '\n';
      }
    };
  }

  files.forEach((file) => {
    if (file.endsWith('.md')) {
      if (!ignoredFiles || !ignoredFiles?.includes(file)) {
        processMarkdown(file, files);
      }
    } else if (
      file.endsWith('jpg') ||
      file.endsWith('jpeg') ||
      file.endsWith('png') ||
      file.endsWith('gif') ||
      file.endsWith('webp')
    ) {
      console.log('process: ' + file);
      processImage(file);
    }
  });

  addContainerXml();

  addContentOpf();

  addNavXhtml();

  addCoverXhtml();

  addTitlePageXhtml();

  addTocNcx();

  addStylesheet();

  zip.generateAsync({ type: 'nodebuffer' }).then((content) => {
    writeFileSync(outputPath, content as Buffer);
  });

  // if (options.verbose) {
  //   console.log('chapters: ', chapters);
  //   console.log('files: ', fileNames);
  //   console.log('images: ', images);
  // }

  // console.log(
  //   'epub: ' + join(options.bookDirectory, 'book-' + metadata.title + '.epub'),
  // );
}
