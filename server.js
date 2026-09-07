"use strict";

const fs = require("fs");
const path = require("path");
const { parseCPX, parseCPXNodes } = require("./cpxParser.js");
const { getLanguageService: getHtmlLanguageService } = require("vscode-html-languageservice");
const htmlService = getHtmlLanguageService();
const {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    SemanticTokensBuilder,
    TextDocumentSyncKind,
    CompletionItemKind,
    InsertTextFormat,
    InsertTextMode,
    MarkupKind,
    Location,
    Position,
    Range,
    Diagnostic,
    DiagnosticSeverity,
    DiagnosticTag
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const workspaceRoots = [];
const documentIndex = new Map();
const exportIndex = new Map();
// Maps a CPX package name (Flow package key, e.g. "Sitegeist.PaperTiger.CPX")
// to an array of { root, sourcePath }. Mirrors the component-engine convention
// where every Flow package is a CPX package with sourcePath =
// <packageRoot>/Components. The same package can exist at several locations
// (e.g. Packages/Plugins/ and a local backup/development copy), so all roots
// are kept and files in any copy map back to the same package name.
const packageIndex = new Map();
const semanticTokenLegend = {
    tokenTypes: ["class", "enum", "text"],
    tokenModifiers: ["declaration"]
};

function toFsPath(uri) {
    if (!uri.startsWith("file://")) {
        return null;
    }

    return decodeURIComponent(uri.replace("file://", ""));
}

function toUri(fsPath) {
    return `file://${fsPath}`;
}

function normalizePath(filePath) {
    return path.normalize(filePath);
}

function offsetAt(text, position) {
    const lines = text.split(/\r?\n/);
    let offset = 0;

    for (let i = 0; i < position.line; i += 1) {
        offset += (lines[i] || "").length + 1;
    }

    return offset + position.character;
}

function positionAt(text, offset) {
    const lines = text.split(/\r?\n/);
    let remaining = offset;

    for (let line = 0; line < lines.length; line += 1) {
        const length = lines[line].length;
        if (remaining <= length) {
            return Position.create(line, remaining);
        }
        remaining -= length + 1;
    }

    return Position.create(lines.length - 1, (lines[lines.length - 1] || "").length);
}

function makeRange(text, startOffset, endOffset) {
    return Range.create(positionAt(text, startOffset), positionAt(text, endOffset));
}

function parseImports(text) {
    const imports = [];
    const importRegex = /^(\s*)from\s+"([^"]+)"\s+import\s+\{([^}]+)\}/gm;
    let match;

    while ((match = importRegex.exec(text))) {
        const [, , source, rawNames] = match;
        const names = rawNames
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        const baseOffset = match.index + match[0].indexOf(rawNames);

        imports.push({
            source,
            range: makeRange(text, match.index, match.index + match[0].length),
            sourceRange: makeRange(
                text,
                match.index + match[0].indexOf(`"${source}"`) + 1,
                match.index + match[0].indexOf(`"${source}"`) + 1 + source.length
            ),
            names: names.map((name) => {
                const localOffset = rawNames.indexOf(name);
                return {
                    name,
                    range: makeRange(text, baseOffset + localOffset, baseOffset + localOffset + name.length)
                };
            })
        });
    }

    return imports;
}

function parseExports(text) {
    const exports = [];
    const exportRegex = /^\s*export\s+(component|struct|enum)\s+([A-Z][A-Za-z0-9_]*)\s*\{/gm;
    let match;

    while ((match = exportRegex.exec(text))) {
        const kind = match[1];
        const name = match[2];
        const nameOffset = match.index + match[0].lastIndexOf(name);
        const blockStart = match.index + match[0].lastIndexOf("{");
        const blockEnd = findBlockEnd(text, blockStart);
        exports.push({
            kind,
            name,
            range: makeRange(text, nameOffset, nameOffset + name.length),
            bodyRange: makeRange(text, blockStart, blockEnd + 1),
            members: kind === "enum"
                ? parseEnumMembers(text.slice(blockStart + 1, blockEnd))
                : [],
            props: kind === "component" || kind === "struct"
                ? parsePropertyDeclarations(text.slice(blockStart + 1, blockEnd), blockStart + 1, text)
                : []
        });
    }

    return exports;
}

function parseEnumMembers(blockText) {
    const members = [];
    const memberRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?\s*$/gm;
    let match;

    while ((match = memberRegex.exec(blockText))) {
        members.push({
            name: match[1],
            value: match[2] ? match[2].trim() : ""
        });
    }

    return members;
}

function findBlockEnd(text, blockStart) {
    let depth = 0;

    for (let i = blockStart; i < text.length; i += 1) {
        if (text[i] === "{") {
            depth += 1;
        } else if (text[i] === "}") {
            depth -= 1;
            if (depth === 0) {
                return i;
            }
        }
    }

    return text.length;
}

// A single type atom: an optional `?`, then either a `list<…>` generic
// (component-engine 1.0.0-alpha4+ — replaced the old `Type[]` suffix) or a
// bare primitive/identifier name.
const TYPE_ATOM_SOURCE = '\\??(?:list<\\s*\\??(?:slot|boolean|string|number|[A-Z][A-Za-z0-9_]*)\\s*>|(?:slot|boolean|string|number|[A-Z][A-Za-z0-9_]*))';

function parsePropertyDeclarations(blockText, baseOffset = 0, fullText = blockText) {
    const props = [];
    const propertyRegex = new RegExp(
        `^\\s*([a-z][A-Za-z0-9_]*)\\s*:\\s*(${TYPE_ATOM_SOURCE}(?:\\s*\\|\\s*${TYPE_ATOM_SOURCE})*)\\s*$`,
        'gm'
    );
    let match;

    while ((match = propertyRegex.exec(blockText))) {
        const fullMatch = match[0];
        const name = match[1];
        const type = match[2];
        const matchStart = baseOffset + match.index;
        const nameStart = matchStart + fullMatch.indexOf(name);
        const typeStart = matchStart + fullMatch.lastIndexOf(type);
        props.push({
            name,
            type,
            range: makeRange(fullText, nameStart, nameStart + name.length),
            typeRange: makeRange(fullText, typeStart, typeStart + type.length)
        });
    }

    return props;
}

/**
 * Scans the render body of a component for bare lowercase identifiers used in
 * expression positions: match subjects, brace expressions, and access chains.
 * Returns [{name, range}] — each entry is one occurrence.
 */
function parseIdentifierUsagesInRender(text, component) {
    const bodyStart = offsetAt(text, component.bodyRange.start);
    const bodyEnd = offsetAt(text, component.bodyRange.end);
    const bodyText = text.slice(bodyStart, bodyEnd);

    const renderMatch = /\brender\b/.exec(bodyText);
    if (!renderMatch) return [];

    const renderOffset = bodyStart + renderMatch.index + renderMatch[0].length;
    const renderText = bodyText.slice(renderMatch.index + renderMatch[0].length);

    // Strip string literals to avoid false matches inside "path/To/File.cpx"
    const stripped = renderText.replace(/"[^"]*"/g, (m) => ' '.repeat(m.length));

    const KEYWORDS = new Set(['null', 'true', 'false', 'match', 'default', 'render', 'slot']);
    const usages = [];

    function addUsage(name, matchIndex, nameIndexInMatch) {
        if (KEYWORDS.has(name)) return;
        const nameOffset = renderOffset + matchIndex + nameIndexInMatch;
        usages.push({ name, range: makeRange(text, nameOffset, nameOffset + name.length) });
    }

    // Pattern 1: match (identifier) — match subject
    const matchSubjectRe = /\bmatch\s*\(\s*([a-z][A-Za-z0-9_]*)\s*\)/g;
    let m;
    while ((m = matchSubjectRe.exec(stripped))) {
        addUsage(m[1], m.index, m[0].indexOf(m[1]));
    }

    // Pattern 2: {identifier} — bare identifier expression (e.g. {button}, content={headline})
    const braceExprRe = /\{\s*([a-z][A-Za-z0-9_]*)\s*\}/g;
    while ((m = braceExprRe.exec(stripped))) {
        addUsage(m[1], m.index, m[0].indexOf(m[1]));
    }

    // Pattern 3: identifier. — prop used as access chain root (e.g. prop.field?.nested)
    // Must not be preceded by . (avoid matching inside PascalCase.member)
    const accessChainRe = /(?<![.A-Za-z0-9_])([a-z][A-Za-z0-9_]*)\./g;
    while ((m = accessChainRe.exec(stripped))) {
        addUsage(m[1], m.index, m[0].indexOf(m[1]));
    }

    return usages;
}

function parseComponentUsages(text) {
    const usages = [];
    const tagRegex = /<([A-Z][A-Za-z0-9_]*)\b/g;
    let match;

    while ((match = tagRegex.exec(text))) {
        const name = match[1];
        const startOffset = match.index + 1;
        usages.push({
            name,
            range: makeRange(text, startOffset, startOffset + name.length)
        });
    }

    return usages;
}

function parseTypeUsages(text) {
    const usages = [];
    const propertyRegex = /^\s*[a-z][A-Za-z0-9_]*\s*:\s*([^\n]+)$/gm;
    let match;

    while ((match = propertyRegex.exec(text))) {
        const typesText = match[1];
        const baseOffset = match.index + match[0].lastIndexOf(typesText);
        const typeRegex = /\??([A-Z][A-Za-z0-9_]*)(\[\])?/g;
        let typeMatch;

        while ((typeMatch = typeRegex.exec(typesText))) {
            const name = typeMatch[1];
            const isCollection = typeMatch[2] === "[]";
            const startOffset = baseOffset + typeMatch.index + typeMatch[0].lastIndexOf(name);
            usages.push({
                name,
                isCollection,
                range: makeRange(text, startOffset, startOffset + name.length)
            });
        }
    }

    return usages;
}

function parseEnumMemberUsages(text) {
    // Strip string literal contents so file paths like "Accordion.cpx"
    // don't get matched as enum member accesses
    const stripped = text.replace(/"[^"]*"/g, (m) => '"' + ' '.repeat(m.length - 2) + '"');
    const usages = [];
    const enumRegex = /\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let match;

    while ((match = enumRegex.exec(stripped))) {
        const owner = match[1];
        const member = match[2];
        const memberStart = match.index + match[0].lastIndexOf(member);
        usages.push({
            owner,
            member,
            range: makeRange(text, memberStart, memberStart + member.length)
        });
    }

    return usages;
}

/**
 * Scan backwards from `offset` in `text` to find the nearest opening PascalCase
 * tag name (e.g. `Headline` in `<Headline `). Returns null if none found or if
 * the nearest `<` starts a lowercase/closing tag.
 */
function findEnclosingPascalTag(text, offset) {
    const before = text.slice(0, offset);
    const tagStart = before.lastIndexOf('<');
    if (tagStart === -1) return null;
    const tagSlice = text.slice(tagStart);
    const tagNameMatch = tagSlice.match(/^<([A-Z][A-Za-z0-9_]*)/);
    return tagNameMatch ? tagNameMatch[1] : null;
}

/**
 * Finds every `attrName={EnumType.MEMBER}` expression inside PascalCase tag
 * attribute positions. Returns [{tagName, attrName, typeName, memberName,
 * typeRange, memberRange}].
 */
function parseAttributeValueEnumUsages(text) {
    // Strip string literals so paths like "Foo.cpx" don't match
    const stripped = text.replace(/"[^"]*"/g, (m) => ' '.repeat(m.length));
    const results = [];
    const re = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*\{\s*([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
    let m;
    while ((m = re.exec(stripped))) {
        const tagName = findEnclosingPascalTag(stripped, m.index);
        if (!tagName) continue;

        const attrName = m[1];
        const typeName = m[2];
        const memberName = m[3];
        const typeOffset = m.index + m[0].indexOf(typeName);
        const memberOffset = m.index + m[0].lastIndexOf(memberName);

        results.push({
            tagName,
            attrName,
            typeName,
            memberName,
            typeRange: makeRange(text, typeOffset, typeOffset + typeName.length),
            memberRange: makeRange(text, memberOffset, memberOffset + memberName.length)
        });
    }
    return results;
}

/**
 * Finds attribute values that are raw literals (string, boolean, number) on
 * PascalCase component tags. Covers both brace syntax `attr={"val"}` /
 * `attr={true}` and bare string syntax `attr="val"`.
 * Returns [{tagName, attrName, literalType, valueRange}].
 */
function parseAttributeValueLiteralUsages(text) {
    const results = [];

    function push(tagName, attrName, literalType, matchIndex, matchStr) {
        // Highlight from the `{` (or `"`) to end of match
        const valueStart = matchIndex + matchStr.search(/[{"]/);
        results.push({
            tagName, attrName, literalType,
            valueRange: makeRange(text, valueStart, matchIndex + matchStr.length)
        });
    }

    let m;

    // Brace-wrapped string literal: attr={"..."}
    const braceStringRe = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*\{"[^"]*"\}/g;
    while ((m = braceStringRe.exec(text))) {
        const tagName = findEnclosingPascalTag(text, m.index);
        if (!tagName) continue;
        push(tagName, m[1], 'string', m.index, m[0]);
    }

    // Brace-wrapped boolean / number literal: attr={true}, attr={42}, attr={0xFF}
    const braceLiteralRe = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*\{(true|false|null|0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?)\}/g;
    while ((m = braceLiteralRe.exec(text))) {
        const tagName = findEnclosingPascalTag(text, m.index);
        if (!tagName) continue;
        const literal = m[2];
        const literalType = (literal === 'true' || literal === 'false') ? 'boolean'
            : literal === 'null' ? 'null'
            : 'number';
        push(tagName, m[1], literalType, m.index, m[0]);
    }

    // Bare string attribute: attr="..." (no braces)
    const bareStringRe = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*"[^"]*"/g;
    while ((m = bareStringRe.exec(text))) {
        const tagName = findEnclosingPascalTag(text, m.index);
        if (!tagName) continue;
        push(tagName, m[1], 'string', m.index, m[0]);
    }

    return results;
}

/**
 * Inside `class={[ ... ]}` array expressions, every value must be a string.
 * Returns [{range, message}] for any match arm whose value is a component tag.
 *
 * Strategy: find every `class={[` occurrence, extract the bracket contents with
 * depth tracking, then scan for `-> <UpperCase` arm values inside.
 */
function parseClassArrayErrors(text) {
    const results = [];
    const classRe = /\bclass=\{\[/g;
    let m;
    while ((m = classRe.exec(text))) {
        const start = m.index + m[0].length;
        let depth = 1, i = start;
        while (i < text.length && depth > 0) {
            if (text[i] === '[') depth++;
            else if (text[i] === ']') depth--;
            i++;
        }
        const content = text.slice(start, i - 1);
        const base = start;

        // Any match arm whose value is a tag (component or HTML): -> <Tag
        const armRe = /->\s*(<[A-Za-z][A-Za-z0-9_-]*)/g;
        let arm;
        while ((arm = armRe.exec(content))) {
            const tagStart = base + arm.index + arm[0].indexOf('<');
            results.push({
                range: makeRange(text, tagStart, tagStart + arm[1].length),
                message: 'Component tag is not valid here — class array values must be strings'
            });
        }
    }
    return results;
}

function indexDocument(fsPath, text) {
    const normalized = normalizePath(fsPath);
    const parsed = {
        path: normalized,
        imports: parseImports(text),
        exports: parseExports(text),
        usages: parseComponentUsages(text),
        typeUsages: parseTypeUsages(text),
        enumMemberUsages: parseEnumMemberUsages(text),
        attrValueEnumUsages: parseAttributeValueEnumUsages(text),
        attrValueLiteralUsages: parseAttributeValueLiteralUsages(text),
        text
    };

    documentIndex.set(normalized, parsed);

    for (const [name, locations] of exportIndex.entries()) {
        exportIndex.set(
            name,
            locations.filter((entry) => entry.path !== normalized)
        );
        if (exportIndex.get(name).length === 0) {
            exportIndex.delete(name);
        }
    }

    for (const exported of parsed.exports) {
        const entries = exportIndex.get(exported.name) || [];
        entries.push({
            name: exported.name,
            path: normalized,
            kind: exported.kind,
            props: exported.props,
            range: exported.range
        });
        exportIndex.set(exported.name, entries);
    }
}

function refreshDocumentFromDisk(fsPath) {
    try {
        const text = fs.readFileSync(fsPath, "utf8");
        indexDocument(fsPath, text);
        return documentIndex.get(normalizePath(fsPath)) || null;
    } catch {
        return null;
    }
}

function ensureCompleteExport(exported, ownerPath) {
    if (!exported || !ownerPath) {
        return exported;
    }

    const needsRefresh =
        (exported.kind === "enum" && (!exported.members || exported.members.length === 0)) ||
        ((exported.kind === "component" || exported.kind === "struct") && (!exported.props || exported.props.length === 0));

    if (!needsRefresh) {
        return exported;
    }

    const refreshed = refreshDocumentFromDisk(ownerPath);
    if (!refreshed) {
        return exported;
    }

    return refreshed.exports.find((entry) => entry.name === exported.name) || exported;
}

// Derives the Flow package key from a composer manifest the same way the
// component-engine does: explicit extra.neos["package-key"] first, otherwise
// the shortest psr-4 namespace ("Vendor\\Package\\" -> "Vendor.Package").
function derivePackageKey(manifest) {
    const explicit = manifest && manifest.extra && manifest.extra.neos && manifest.extra.neos["package-key"];
    if (typeof explicit === "string" && explicit.length > 0) {
        return explicit;
    }

    const psr4 = manifest && manifest.autoload && manifest.autoload["psr-4"];
    if (psr4) {
        const namespaces = Object.keys(psr4).sort((a, b) => a.length - b.length);
        if (namespaces.length > 0) {
            return namespaces[0].replace(/\\+$/, "").replace(/\\/g, ".");
        }
    }

    return null;
}

function registerPackageRoot(dir) {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dir, "composer.json"), "utf8"));
        const packageName = derivePackageKey(manifest);
        if (!packageName) {
            return;
        }

        const root = normalizePath(dir);
        const sourcePath = normalizePath(path.join(dir, "Components"));
        const entries = packageIndex.get(packageName) || [];
        if (entries.some((entry) => entry.root === root)) {
            return;
        }
        entries.push({ root, sourcePath });
        // Keep the shallowest root first so name → path resolution prefers it.
        entries.sort((a, b) => a.root.length - b.root.length);
        packageIndex.set(packageName, entries);
    } catch {
        // Unreadable or invalid composer.json — not a package root.
    }
}

// Returns { name, root, sourcePath } of the package whose sourcePath contains
// the file, preferring the most specific (longest) match for nested packages.
function packageForFile(fsPath) {
    let best = null;
    for (const [name, entries] of packageIndex.entries()) {
        for (const pkg of entries) {
            if (fsPath === pkg.sourcePath || fsPath.startsWith(pkg.sourcePath + path.sep)) {
                if (!best || pkg.sourcePath.length > best.sourcePath.length) {
                    best = { name, root: pkg.root, sourcePath: pkg.sourcePath };
                }
            }
        }
    }
    return best;
}

function resolveImportPath(fromFile, importPath) {
    if (importPath.startsWith(".")) {
        const resolved = normalizePath(path.resolve(path.dirname(fromFile), importPath));
        return path.extname(resolved) ? resolved : `${resolved}.cpx`;
    }

    // Package-style import: "Vendor.Package/Sub/Path.cpx" resolves against the
    // package's source path, matching the component-engine build.
    const slash = importPath.indexOf("/");
    if (slash === -1) {
        return null;
    }

    const entries = packageIndex.get(importPath.slice(0, slash));
    if (!entries || entries.length === 0) {
        return null;
    }

    const subPath = importPath.slice(slash + 1);
    let fallback = null;
    for (const pkg of entries) {
        let resolved = normalizePath(path.join(pkg.sourcePath, subPath));
        resolved = path.extname(resolved) ? resolved : `${resolved}.cpx`;
        if (fs.existsSync(resolved)) {
            return resolved;
        }
        if (!fallback) {
            fallback = resolved;
        }
    }
    return fallback;
}

function isInsideRange(position, range) {
    if (position.line < range.start.line || position.line > range.end.line) {
        return false;
    }

    if (position.line === range.start.line && position.character < range.start.character) {
        return false;
    }

    if (position.line === range.end.line && position.character > range.end.character) {
        return false;
    }

    return true;
}

function currentWord(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset).match(/[A-Za-z0-9_]+$/);
    const right = text.slice(offset).match(/^[A-Za-z0-9_]*/);
    const word = `${left ? left[0] : ""}${right ? right[0] : ""}`;

    return word || null;
}

function isInsideString(text, position) {
    const offset = offsetAt(text, position);
    let quote = null;

    for (let i = 0; i < offset; i += 1) {
        const char = text[i];
        const prev = text[i - 1];

        if (quote) {
            if (char === quote && prev !== "\\") {
                quote = null;
            }
            continue;
        }

        if (char === "\"" && prev !== "\\") {
            quote = char;
        }
    }

    return quote !== null;
}

function isTypeContext(text, position) {
    const offset = offsetAt(text, position);
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    // A trailing `(?:<\s*ATOM)?` also matches the single type argument of a
    // `list<…>` generic, so completions still work while typing its item type.
    return /:\s*(?:\??[A-Z]?[A-Za-z0-9_]*\s*\|\s*)*\??[A-Z]?[A-Za-z0-9_]*(?:<\s*\??[A-Z]?[A-Za-z0-9_]*)?$/.test(prefix);
}

// True once the cursor is past an unclosed `<` following the last `:` on the
// line — i.e. already inside a `list<…>` generic's argument, as opposed to
// being positioned to start a new type reference.
function isInsideGenericTypeArgument(text, position) {
    const offset = offsetAt(text, position);
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    const colonIdx = prefix.lastIndexOf(":");
    if (colonIdx === -1) return false;
    return prefix.slice(colonIdx).includes("<");
}

// A `<` immediately preceded by an identifier character (e.g. `list<Foo`)
// opens a generic type argument list, not a tag — a real CPX tag's `<` can
// never follow an identifier with no separator. Every tag-context detector
// below excludes that case so `list<…>` is never mistaken for `<…>`.
const NOT_AFTER_IDENTIFIER = "(?<![A-Za-z0-9_])";

function isGenericBracket(text, ltIndex) {
    return ltIndex > 0 && /[A-Za-z0-9_]/.test(text[ltIndex - 1]);
}

function isTagContext(text, position) {
    const offset = offsetAt(text, position);
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    return new RegExp(`${NOT_AFTER_IDENTIFIER}<[/]?[A-Z][A-Za-z0-9_]*$`).test(prefix)
        || new RegExp(`${NOT_AFTER_IDENTIFIER}<$`).test(prefix);
}

function isHtmlTagNameContext(text, position) {
    const offset = offsetAt(text, position);
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    // Cursor is after a partial lowercase tag name, e.g. <div, <sp, <a
    return new RegExp(`${NOT_AFTER_IDENTIFIER}<[a-z][a-zA-Z0-9-]*$`).test(prefix);
}

const VOID_ELEMENTS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr'
]);

const HTML_REGULAR_TAGS = [
    'a', 'abbr', 'address', 'article', 'aside', 'audio',
    'b', 'bdi', 'bdo', 'blockquote', 'button',
    'canvas', 'caption', 'cite', 'code', 'colgroup',
    'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt',
    'em', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'i', 'iframe', 'ins',
    'kbd', 'label', 'legend', 'li', 'main', 'map', 'mark', 'menu', 'meter',
    'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output',
    'p', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby',
    's', 'samp', 'section', 'select', 'small', 'span', 'strong',
    'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'template', 'textarea',
    'tfoot', 'th', 'thead', 'time', 'tr', 'u', 'ul', 'var', 'video'
];

// Returns the tag name to auto-close when the user types '>',
// or null if auto-closing is not appropriate.
function getAutoCloseTagName(text, position) {
    const offset = offsetAt(text, position);
    const before = text.slice(0, offset);

    // The '>' should be the last character (it was just typed)
    if (!before.endsWith('>')) return null;

    // Don't auto-close self-closing tags: />
    if (/\/\s*>$/.test(before)) return null;

    // Find the opening <
    const openIdx = before.lastIndexOf('<');
    if (openIdx === -1) return null;
    if (isGenericBracket(before, openIdx)) return null;

    const tagSlice = before.slice(openIdx);

    // Must be an opening tag, not a closing </tag>
    if (tagSlice.startsWith('</')) return null;

    // Fragment <> — auto-close with </>
    if (tagSlice === '<>') return '';

    // Extract tag name — must follow immediately after <
    const match = tagSlice.match(/^<([A-Za-z][A-Za-z0-9_:-]*)(?:\s|>)/);
    if (!match) return null;

    const tagName = match[1];

    // Don't auto-close HTML void elements
    if (VOID_ELEMENTS.has(tagName.toLowerCase())) return null;

    return tagName;
}

function isClosingTagContext(text, position) {
    const offset = offsetAt(text, position);
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    return new RegExp(`${NOT_AFTER_IDENTIFIER}<\\/[A-Z][A-Za-z0-9_]*$`).test(prefix)
        || new RegExp(`${NOT_AFTER_IDENTIFIER}<\\/$`).test(prefix);
}

function getOpenTagContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const tagStart = left.lastIndexOf("<");
    if (tagStart === -1) {
        return null;
    }
    if (isGenericBracket(left, tagStart)) {
        return null;
    }

    const tail = left.slice(tagStart);
    if (tail.startsWith("</") || tail.includes(">")) {
        return null;
    }

    const match = tail.match(/^<([A-Z][A-Za-z0-9_]*)(?:\s+[^<>]*)?$/);
    if (!match) {
        return null;
    }

    const attrMatch = tail.match(/\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)?$/);
    return {
        tagName: match[1],
        partialAttribute: attrMatch && attrMatch[1] ? attrMatch[1] : ""
    };
}

// HTML attribute completions are delegated to vscode-html-languageservice (see htmlService above).

function getOpenHtmlTagContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const tagStart = left.lastIndexOf("<");
    if (tagStart === -1) return null;
    if (isGenericBracket(left, tagStart)) return null;
    const tail = left.slice(tagStart);
    if (tail.startsWith("</") || tail.includes(">")) return null;
    const match = tail.match(/^<([a-z][a-zA-Z0-9-]*)(?:\s+[^<>]*)?$/);
    if (!match) return null;
    const attrMatch = tail.match(/\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)?$/);
    return {
        tagName: match[1],
        partialAttribute: attrMatch && attrMatch[1] ? attrMatch[1] : ""
    };
}

// When the cursor is inside an opening tag like <MyC| and there is already a matching
// close tag directly after (e.g. </MyC>), returns the absolute positions needed to
// build a textEdit that replaces the word + ></oldTag> in one operation so the
// accepted completion does not produce a duplicate closing tag.
// Returns { wordStart, existingCloseTagEnd } or null.
function getExistingCloseTagInfo(text, position) {
    const offset = offsetAt(text, position);
    const before = text.slice(0, offset);
    const openIdx = before.lastIndexOf('<');
    if (openIdx === -1) return null;
    if (isGenericBracket(before, openIdx)) return null;
    const tagSlice = before.slice(openIdx);
    // must be an opening tag, not yet closed
    if (tagSlice.startsWith('</') || tagSlice.includes('>')) return null;
    const nameMatch = tagSlice.match(/^<([A-Za-z][A-Za-z0-9_:-]*)/);
    if (!nameMatch) return null;
    const partialName = nameMatch[1];
    const after = text.slice(offset);
    // Match: > (optional whitespace) </partialName (exact) optional-whitespace >
    const closeTagMatch = after.match(new RegExp(`^>\\s*<\\/${partialName}\\s*>`));
    if (!closeTagMatch) return null;
    return {
        wordStart: openIdx + 1, // absolute position of first char of tag name
        existingCloseTagEnd: offset + closeTagMatch[0].length // absolute position after </oldName>
    };
}

function buildComponentSnippet(candidate, closingTagContext) {
    if (closingTagContext) {
        return `${candidate.name}>`;
    }

    const props = candidate.props || [];
    const hasContentSlot = props.some((prop) => prop.name === "content" && /(?:^|\|)\s*\??slot\s*(?:\||$)/.test(prop.type));

    if (hasContentSlot) {
        return `${candidate.name}>$0</${candidate.name}>`;
    }

    return `${candidate.name} />`;
}

async function scanDirectory(root) {
    const entries = await fs.promises.readdir(root, { withFileTypes: true });

    if (entries.some((entry) => entry.isFile() && entry.name === "composer.json")) {
        registerPackageRoot(root);
    }

    for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) {
            continue;
        }

        const fullPath = path.join(root, entry.name);

        if (entry.isDirectory()) {
            await scanDirectory(fullPath);
            continue;
        }

        if (!entry.isFile() || path.extname(entry.name) !== ".cpx") {
            continue;
        }

        const text = await fs.promises.readFile(fullPath, "utf8");
        indexDocument(fullPath, text);
    }
}

async function rebuildIndex() {
    documentIndex.clear();
    exportIndex.clear();
    packageIndex.clear();

    for (const root of workspaceRoots) {
        try {
            await scanDirectory(root);
        } catch (error) {
            connection.console.error(`Failed to scan ${root}: ${error.message}`);
        }
    }

    for (const document of documents.all()) {
        const fsPath = toFsPath(document.uri);
        if (fsPath) {
            indexDocument(fsPath, document.getText());
        }
    }
}

function getDocumentData(uri) {
    const fsPath = toFsPath(uri);
    if (!fsPath) {
        return null;
    }

    return documentIndex.get(normalizePath(fsPath)) || null;
}

function getExportAtPosition(parsed, position) {
    return parsed.exports.find((entry) => isInsideRange(position, entry.bodyRange)) || null;
}

/**
 * Returns { tagName, attrName } when the cursor is inside an attribute value
 * expression: `<MyTag attrName={|`. Returns null otherwise.
 */
function getAttributeValueContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);

    // Must be inside an open brace that's an attribute value: `attrname={...`
    const attrValueMatch = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*\{[^}]*$/.exec(left);
    if (!attrValueMatch) return null;

    // Confirm we're still inside an open tag (no `>` after the last `<`)
    const tagStart = left.lastIndexOf('<');
    if (tagStart === -1) return null;
    const tail = left.slice(tagStart);
    if (tail.startsWith('</') || tail.includes('>')) return null;
    const tagMatch = tail.match(/^<([A-Z][A-Za-z0-9_]*)/);
    if (!tagMatch) return null;

    return { tagName: tagMatch[1], attrName: attrValueMatch[1] };
}

/**
 * Returns { subject } when the cursor is anywhere inside a match body, where
 * `subject` is the match expression (e.g. "columns" in `match (columns) { | }`).
 * Works even when existing arms are present — uses brace-depth tracking.
 * Use this for expression-context completions to restrict enum suggestions.
 */
function getActiveMatchContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);

    // Find every `match (subject) {` in the text before the cursor
    const matchRe = /\bmatch\s*\(?\s*([\w.]+)\s*\)?\s*\{/g;
    let result = null;
    let m;
    while ((m = matchRe.exec(left))) {
        const braceOpen = m.index + m[0].length - 1;
        // Count net brace depth from this `{` to cursor — if still open, cursor is inside
        let depth = 0;
        for (let i = braceOpen; i < offset; i++) {
            if (left[i] === '{') depth++;
            else if (left[i] === '}') depth--;
        }
        if (depth > 0) result = { subject: m[1] };
    }
    return result;
}

/**
 * Detects `PascalCase.` or `PascalCase.partial` at the cursor — the user is
 * typing an enum member access. Returns { typeName, partial } or null.
 */
function getPascalMemberAccessContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const match = left.match(/\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);
    if (!match) return null;
    return { typeName: match[1], partial: match[2] || '' };
}

function getMemberAccessContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const match = left.match(/\b([a-z][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);
    if (!match) {
        return null;
    }

    return {
        target: match[1],
        partial: match[2] || ""
    };
}

/**
 * Detect if the cursor is right after the `match` keyword, before any `{`.
 * Returns { partial: string } where partial is whatever the user has typed
 * so far as the subject (may be empty), or null if not in this position.
 */
function getMatchSubjectContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    // Fire as soon as the user starts typing the keyword: `mat`, `matc`, `match`,
    // or `match propName`. The textEdit range always covers from the first letter
    // to the cursor, so the snippet correctly replaces whatever has been typed.
    const m = left.match(/\b(ma(?:t(?:ch?)?)?)(\s+([\w.]*))?$/);
    if (!m) return null;
    const keyword = m[1]; // 'ma', 'mat', 'matc', or 'match'
    // Subject filtering only applies once the full keyword + space is present
    const partial = (keyword === 'match' && m[3] !== undefined) ? m[3] : '';
    return { partial, matchStart: offset - m[0].length };
}

/**
 * Detect if the cursor is at the opening of a match body and return the
 * subject identifier so we can offer enum-aware arm completion.
 *
 * Matches patterns like:
 *   match (propName) {         ← cursor here
 *   match propName {           ← cursor here
 *   match (prop.field) {       ← subject is prop.field
 *
 * Returns { subject: string } or null.
 */
function getMatchBodyContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    // Accept optional whitespace/newlines after `{`
    const m = left.match(/\bmatch\s*\(?\s*([\w.]+)\s*\)?\s*\{\s*$/);
    if (!m) return null;
    return { subject: m[1] };
}

/**
 * Build a VSCode snippet for all arms of an enum, e.g.:
 *
 *   Status.ACTIVE -> $1,
 *   Status.INACTIVE -> $2,
 *   default -> $0
 */
function detectIndent(text) {
    for (const line of text.split(/\r?\n/)) {
        if (/^\t/.test(line)) return '\t';
        const m = line.match(/^( {2,})/);
        if (m) return m[1].length % 4 === 0 ? '    ' : '  ';
    }
    return '    ';
}

function buildMatchArmsSnippet(enumExport, indent) {
    const ind = indent || '    ';
    const name = enumExport.name;
    const members = enumExport.members || [];
    const lines = members.map((m, i) => `${ind}${name}.${m.name} -> "$${i + 1}"`);
    lines.push(`${ind}default -> "$0"`);
    return lines.join(",\n") + "\n";
}

function isExpressionContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const openBraces = (left.match(/\{/g) || []).length;
    const closeBraces = (left.match(/\}/g) || []).length;
    return openBraces > closeBraces;
}

function resolveImportedSymbol(parsed, symbolName) {
    const imported = parsed.imports.find((entry) => entry.names.some((item) => item.name === symbolName));
    if (imported) {
        const resolved = resolveImportPath(parsed.path, imported.source);
        const target = resolved ? documentIndex.get(resolved) : null;
        const exported = target && target.exports.find((entry) => entry.name === symbolName);
        if (exported) {
            return exported;
        }
    }

    const local = parsed.exports.find((entry) => entry.name === symbolName);
    if (local) {
        return local;
    }

    const global = exportIndex.get(symbolName);
    return global && global.length > 0 ? global[0] : null;
}

function extractNamedTypes(typeText) {
    return (typeText.match(/\b[A-Z][A-Za-z0-9_]*\b/g) || []);
}

function resolveStructForProperty(parsed, position, propertyName) {
    const owner = getExportAtPosition(parsed, position);
    if (!owner || !owner.props) {
        return null;
    }

    const prop = owner.props.find((entry) => entry.name === propertyName);
    if (!prop) {
        return null;
    }

    for (const typeName of extractNamedTypes(prop.type)) {
        const resolved = resolveImportedSymbol(parsed, typeName);
        if (resolved && resolved.kind === "struct") {
            return resolved;
        }
    }

    return null;
}

function resolvePropertyAtPosition(parsed, position, word) {
    const owner = getExportAtPosition(parsed, position);
    if (!owner || !owner.props) {
        return null;
    }

    for (const prop of owner.props) {
        if (prop.range && isInsideRange(position, prop.range)) {
            return prop;
        }
        if (prop.typeRange && isInsideRange(position, prop.typeRange)) {
            return prop;
        }
    }

    if (!word || !/^[a-z][A-Za-z0-9_]*$/.test(word)) {
        return null;
    }

    return owner.props.find((prop) => prop.name === word) || null;
}

function resolveComponentPropAtPosition(parsed, position, word) {
    const openTagContext = getOpenTagContext(parsed.text, position);
    if (!openTagContext || !word || !/^[a-z][A-Za-z0-9_]*$/.test(word)) {
        return null;
    }

    const resolved = resolveImportedSymbol(parsed, openTagContext.tagName);
    if (!resolved || !resolved.props) {
        return null;
    }

    const prop = resolved.props.find((entry) => entry.name === word);
    if (!prop) {
        return null;
    }

    const imported = parsed.imports.find((entry) => entry.names.some((item) => item.name === openTagContext.tagName));
    if (imported) {
        const resolvedPath = resolveImportPath(parsed.path, imported.source);
        const ownerParsed = resolvedPath
            ? (refreshDocumentFromDisk(resolvedPath) || documentIndex.get(resolvedPath))
            : null;
        return {
            prop,
            ownerParsed: ownerParsed || parsed
        };
    }

    return {
        prop,
        ownerParsed: parsed
    };
}

function buildHoverCodeLines(exported) {
    const lines = [`export ${exported.kind} ${exported.name} {`];

    if (exported.kind === "enum") {
        for (const member of exported.members || []) {
            lines.push(member.value ? `    ${member.name}(${member.value})` : `    ${member.name}`);
        }
    } else {
        for (const prop of exported.props || []) {
            lines.push(`    ${prop.name}: ${prop.type}`);
        }
    }

    lines.push("}");

    return lines;
}

function buildHoverForExport(exported) {
    return {
        contents: {
            kind: MarkupKind.Markdown,
            value: ["```cpx", ...buildHoverCodeLines(exported), "```"].join("\n")
        }
    };
}

function buildHoverForProperty(prop, parsed) {
    const blocks = [
        ["```cpx", `${prop.name}: ${prop.type}`, "```"].join("\n")
    ];

    for (const typeName of extractNamedTypes(prop.type)) {
        const exported = resolveSymbolExport(parsed, typeName);
        if (exported) {
            blocks.push(["```cpx", buildHoverCodeLines(exported).join("\n"), "```"].join("\n"));
        }
    }

    return {
        contents: {
            kind: MarkupKind.Markdown,
            value: blocks.join("\n\n")
        }
    };
}

function resolveSymbolExport(parsed, symbolName) {
    const imported = parsed.imports.find((entry) => entry.names.some((item) => item.name === symbolName));
    if (imported) {
        const resolved = resolveImportPath(parsed.path, imported.source);
        const target = resolved ? documentIndex.get(resolved) : null;
        const exported = target && target.exports.find((entry) => entry.name === symbolName);
        if (exported) {
            return ensureCompleteExport(exported, resolved);
        }
    }

    const localExport = parsed.exports.find((entry) => entry.name === symbolName);
    if (localExport) {
        return ensureCompleteExport(localExport, parsed.path);
    }

    const candidates = exportIndex.get(symbolName);
    if (candidates && candidates.length > 0) {
        const target = documentIndex.get(candidates[0].path);
        const exported = target && target.exports.find((entry) => entry.name === symbolName);
        return ensureCompleteExport(exported, candidates[0].path);
    }

    return null;
}

// Builds the import source for importing targetPath from within fromFile.
// Stays relative inside the same package; crosses package boundaries with a
// package-style path ("Vendor.Package/Sub/Path.cpx"), since relative imports
// must not escape the package source root in the component-engine build.
function buildImportSource(fromFile, targetPath) {
    const fromPackage = packageForFile(fromFile);
    const targetPackage = packageForFile(targetPath);

    if (targetPackage && (!fromPackage || fromPackage.name !== targetPackage.name)) {
        const subPath = path.relative(targetPackage.sourcePath, targetPath).replace(/\\/g, "/");
        return `${targetPackage.name}/${subPath}`;
    }

    const relativePath = path.relative(path.dirname(fromFile), targetPath).replace(/\\/g, "/");
    return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function uniqueAutoImportCandidates(parsed, preferredKind) {
    const importedNames = new Set(parsed.imports.flatMap((entry) => entry.names.map((item) => item.name)));
    const localExports = new Set(parsed.exports.map((entry) => entry.name));
    const fromPackage = packageForFile(parsed.path);
    const seen = new Set();
    const items = [];

    for (const [name, definitions] of exportIndex.entries()) {
        if (importedNames.has(name) || localExports.has(name)) {
            continue;
        }

        const ordered = preferredKind
            ? [...definitions].sort((a, b) => Number(b.kind === preferredKind) - Number(a.kind === preferredKind))
            : definitions;

        // One candidate per distinct import source, so the same component name
        // in several packages yields several suggestions instead of an
        // arbitrary winner. Duplicate copies of the same package (vendor/,
        // backups) collapse naturally: they produce the same package-style
        // source string.
        for (const definition of ordered) {
            const targetPackage = packageForFile(definition.path);

            // When the importing file lives in a package, skip exports that
            // live in no package source root — the component build could not
            // import them (vendor copies, test fixtures, etc.).
            if (fromPackage && !targetPackage) {
                continue;
            }

            const source = buildImportSource(parsed.path, definition.path);
            const key = `${name} ${source}`;
            if (seen.has(key)) {
                continue;
            }

            seen.add(key);
            items.push({
                name,
                kind: definition.kind,
                props: definition.props,
                source,
                // Same-package (relative) suggestions rank above cross-package ones.
                samePackage: Boolean(fromPackage && targetPackage && fromPackage.name === targetPackage.name)
            });
        }
    }

    return items.sort((a, b) => a.name.localeCompare(b.name) || Number(b.samePackage) - Number(a.samePackage));
}

function localComponentCandidates(parsed) {
    const seen = new Set();
    const items = [];

    for (const imported of parsed.imports) {
        for (const named of imported.names) {
            const resolved = resolveImportedSymbol(parsed, named.name);
            if (!resolved || resolved.kind !== "component" || seen.has(named.name)) {
                continue;
            }

            seen.add(named.name);
            items.push({
                name: named.name,
                kind: resolved.kind,
                props: resolved.props
            });
        }
    }

    for (const exported of parsed.exports) {
        if (exported.kind !== "component" || seen.has(exported.name)) {
            continue;
        }

        seen.add(exported.name);
        items.push({
            name: exported.name,
            kind: exported.kind,
            props: exported.props
        });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
}

function importInsertPosition(parsed) {
    const lines = parsed.text.split(/\r?\n/);
    let line = 0;

    while (line < lines.length && /^(\s*from\s+"[^"]+"\s+import\s+\{[^}]+\}\s*)$/.test(lines[line])) {
        line += 1;
    }

    return Position.create(line, 0);
}

function tokenTypeIndex(kind) {
    return semanticTokenLegend.tokenTypes.indexOf(kind === "enum" ? "enum" : "class");
}

const TEXT_TOKEN_TYPE = 2; // index of "text" in semanticTokenLegend.tokenTypes

function collectSemanticTokens(parsed) {
    const tokenKinds = new Map();
    // Collect all tokens as plain objects first so we can sort before building.
    // SemanticTokensBuilder requires strict document order (line asc, char asc).
    /** @type {Array<[number, number, number, number, number]>} */
    const tokens = [];

    function pushToken(line, char, length, type, mod) {
        if (length > 0) tokens.push([line, char, length, type, mod]);
    }

    for (const exported of parsed.exports) {
        tokenKinds.set(exported.name, exported.kind);
        pushToken(
            exported.range.start.line,
            exported.range.start.character,
            exported.range.end.character - exported.range.start.character,
            tokenTypeIndex(exported.kind),
            semanticTokenLegend.tokenModifiers.indexOf("declaration")
        );
    }

    for (const importEntry of parsed.imports) {
        for (const importedName of importEntry.names) {
            const resolved = resolveImportPath(parsed.path, importEntry.source);
            const target = resolved ? documentIndex.get(resolved) : null;
            const exported = target && target.exports.find((entry) => entry.name === importedName.name);
            const kind = exported ? exported.kind : "component";
            tokenKinds.set(importedName.name, kind);
            pushToken(
                importedName.range.start.line,
                importedName.range.start.character,
                importedName.range.end.character - importedName.range.start.character,
                tokenTypeIndex(kind),
                0
            );
        }
    }

    for (const usage of parsed.usages) {
        const kind = tokenKinds.get(usage.name) || (exportIndex.get(usage.name)?.[0]?.kind) || "component";
        pushToken(
            usage.range.start.line,
            usage.range.start.character,
            usage.range.end.character - usage.range.start.character,
            tokenTypeIndex(kind),
            0
        );
    }

    for (const usage of parsed.typeUsages) {
        const kind = tokenKinds.get(usage.name) || (exportIndex.get(usage.name)?.[0]?.kind) || "component";
        pushToken(
            usage.range.start.line,
            usage.range.start.character,
            usage.range.end.character - usage.range.start.character,
            tokenTypeIndex(kind),
            0
        );
    }

    // Emit text-content tokens so the semantic layer overrides TextMate's
    // expression coloring for literal text nodes inside tag children.
    // parseCPXNodes re-parses but is synchronous and fast (<1ms for typical files).
    const { textRanges } = parseCPXNodes(parsed.text);
    const lines = parsed.text.split(/\r?\n/);
    for (const r of textRanges) {
        // A text node may span multiple lines — emit one token per line.
        for (let line = r.startLine; line <= r.endLine; line++) {
            const startChar = line === r.startLine ? r.startCol : 0;
            const endChar = line === r.endLine ? r.endCol : (lines[line] || "").length;
            pushToken(line, startChar, endChar - startChar, TEXT_TOKEN_TYPE, 0);
        }
    }

    // Sort into document order before feeding to the builder
    tokens.sort((a, b) => a[0] !== b[0] ? a[0] - b[0] : a[1] - b[1]);

    const builder = new SemanticTokensBuilder();
    for (const [line, char, length, type, mod] of tokens) {
        builder.push(line, char, length, type, mod);
    }

    return builder.build();
}

// ---------------------------------------------------------------------------
// CPX parser validation via `cpx check` (component-engine CLI)
// ---------------------------------------------------------------------------

/**
 * Run the JS CPX parser and return LSP Diagnostics.
 * Returns immediately (synchronous under the hood).
 * @param {string} text
 * @returns {import("vscode-languageserver").Diagnostic[]}
 */
function runCpxCheck(text) {
    const errors = parseCPX(text);
    return errors.map((e) => Diagnostic.create(
        Range.create(
            Position.create(e.startLine, e.startCol),
            Position.create(e.endLine, e.endCol)
        ),
        e.message,
        DiagnosticSeverity.Error,
        undefined,
        "cpx"
    ));
}

// ---------------------------------------------------------------------------

const PRIMITIVE_TYPES = new Set(["boolean", "string", "number", "slot"]);

function unusedImportDiagnostics(parsed) {
    const usedNames = new Set([
        ...parsed.usages.map((u) => u.name),
        ...parsed.typeUsages.map((u) => u.name),
        ...parsed.enumMemberUsages.map((u) => u.owner)
    ]);
    const diagnostics = [];
    for (const importEntry of parsed.imports) {
        const unusedNames = importEntry.names.filter((n) => !usedNames.has(n.name));
        if (unusedNames.length === 0) continue;

        const allUnused = unusedNames.length === importEntry.names.length;
        for (const name of unusedNames) {
            // If the whole import line is unused, fade the entire line.
            // If only some names are unused, fade just the name token.
            const range = allUnused ? importEntry.range : name.range;
            const diag = Diagnostic.create(
                range,
                `"${name.name}" is imported but never used`,
                DiagnosticSeverity.Warning,
                "unused-import",
                "cpx"
            );
            diag.tags = [DiagnosticTag.Unnecessary];
            diagnostics.push(diag);
        }
    }
    return diagnostics;
}

function validateDocument(parsed) {
    const diagnostics = [];

    // 1. Import paths and exported names
    for (const importEntry of parsed.imports) {
        const resolved = resolveImportPath(parsed.path, importEntry.source);
        if (resolved === null) {
            // Package-style import with an unknown package key. Only warn when
            // package discovery actually found packages, to avoid noise in
            // workspaces without composer manifests.
            if (!importEntry.source.startsWith(".") && packageIndex.size > 0) {
                const slash = importEntry.source.indexOf("/");
                const packageName = slash === -1 ? importEntry.source : importEntry.source.slice(0, slash);
                diagnostics.push(Diagnostic.create(
                    importEntry.sourceRange,
                    `Unknown package "${packageName}" — no package with this key was found in the workspace`,
                    DiagnosticSeverity.Warning,
                    "unknown-package",
                    "cpx"
                ));
            }
            continue;
        }

        if (!fs.existsSync(resolved)) {
            diagnostics.push(Diagnostic.create(
                importEntry.sourceRange,
                `Cannot find file "${importEntry.source}"`,
                DiagnosticSeverity.Error,
                undefined,
                "cpx"
            ));
            continue;
        }

        // Relative imports must stay inside the package source root — the
        // component-engine build cannot resolve paths that escape it.
        if (importEntry.source.startsWith(".")) {
            const fromPackage = packageForFile(parsed.path);
            const escapes = fromPackage
                && resolved !== fromPackage.sourcePath
                && !resolved.startsWith(fromPackage.sourcePath + path.sep);
            if (escapes) {
                const targetPackage = packageForFile(resolved);
                const fix = targetPackage ? buildImportSource(parsed.path, resolved) : null;
                const diag = Diagnostic.create(
                    importEntry.sourceRange,
                    fix
                        ? `Relative import escapes package "${fromPackage.name}" and won't resolve in the component build — use "${fix}" instead`
                        : `Relative import escapes package "${fromPackage.name}" and won't resolve in the component build`,
                    DiagnosticSeverity.Error,
                    "cross-package-import",
                    "cpx"
                );
                if (fix) {
                    diag.data = { fix };
                }
                diagnostics.push(diag);
            }
        }

        let target = documentIndex.get(normalizePath(resolved));
        if (!target) {
            target = refreshDocumentFromDisk(resolved);
        }

        if (target) {
            for (const name of importEntry.names) {
                if (!target.exports.find((e) => e.name === name.name)) {
                    diagnostics.push(Diagnostic.create(
                        name.range,
                        `"${name.name}" is not exported from "${importEntry.source}"`,
                        DiagnosticSeverity.Error,
                        undefined,
                        "cpx"
                    ));
                }
            }
        }
    }

    // Strict check for validation: the symbol must be explicitly imported or
    // declared in this file. Unlike resolveImportedSymbol, this never falls
    // back to the global export index — a component that merely exists
    // somewhere in the workspace still won't render in the component build
    // without an import.
    const isImportedOrDeclared = (symbolName) =>
        parsed.imports.some((entry) => entry.names.some((item) => item.name === symbolName))
        || parsed.exports.some((entry) => entry.name === symbolName);

    // 2. Component tag usages — must be imported or locally declared
    for (const usage of parsed.usages) {
        if (!isImportedOrDeclared(usage.name)) {
            const diag = Diagnostic.create(
                usage.range,
                `"${usage.name}" is not imported or declared — it won't render in the component build`,
                DiagnosticSeverity.Error,
                "missing-import",
                "cpx"
            );
            diag.data = { name: usage.name };
            diagnostics.push(diag);
        }
    }

    // 3. Type usages in property declarations — must be imported or locally declared
    for (const usage of parsed.typeUsages) {
        if (PRIMITIVE_TYPES.has(usage.name.toLowerCase())) {
            continue;
        }
        if (!isImportedOrDeclared(usage.name)) {
            const diag = Diagnostic.create(
                usage.range,
                `Type "${usage.name}" is not imported or declared`,
                DiagnosticSeverity.Error,
                "missing-import",
                "cpx"
            );
            diag.data = { name: usage.name };
            diagnostics.push(diag);
        }
    }

    // 4. Unused imports
    diagnostics.push(...unusedImportDiagnostics(parsed));

    // 5. Components must have a render block
    for (const exported of parsed.exports) {
        if (exported.kind !== "component") {
            continue;
        }
        const startOffset = offsetAt(parsed.text, exported.bodyRange.start);
        const endOffset = offsetAt(parsed.text, exported.bodyRange.end);
        const bodyText = parsed.text.slice(startOffset, endOffset);
        if (!/\brender\b/.test(bodyText)) {
            diagnostics.push(Diagnostic.create(
                exported.range,
                `Component "${exported.name}" is missing a render block`,
                DiagnosticSeverity.Error,
                undefined,
                "cpx"
            ));
        }
    }

    // 6. Prop identifier usages in render body must reference a declared prop
    for (const exported of parsed.exports) {
        if (exported.kind !== "component") continue;
        const declaredProps = new Set((exported.props || []).map(p => p.name));
        const identUsages = parseIdentifierUsagesInRender(parsed.text, exported);
        const seen = new Set(); // deduplicate same name+position isn't needed, but avoid same name from multiple patterns
        for (const usage of identUsages) {
            const key = `${usage.name}:${usage.range.start.line}:${usage.range.start.character}`;
            if (seen.has(key)) continue;
            seen.add(key);
            if (!declaredProps.has(usage.name)) {
                diagnostics.push(Diagnostic.create(
                    usage.range,
                    `"${usage.name}" is not a declared prop of "${exported.name}"`,
                    DiagnosticSeverity.Error,
                    undefined,
                    "cpx"
                ));
            }
        }
    }

    // 7. Attribute value enum type checking
    //    <MyTag attr={EnumType.MEMBER} /> — validate:
    //    (a) EnumType is imported
    //    (b) MEMBER exists on EnumType
    //    (c) EnumType matches the declared prop type for attr
    for (const usage of parsed.attrValueEnumUsages) {
        const typeExport = resolveImportedSymbol(parsed, usage.typeName);
        if (!typeExport) {
            diagnostics.push(Diagnostic.create(
                usage.typeRange,
                `"${usage.typeName}" is not imported or declared`,
                DiagnosticSeverity.Warning,
                undefined,
                "cpx"
            ));
            continue;
        }

        // Verify member exists
        const complete = ensureCompleteExport(typeExport, parsed.path);
        const members = (complete || typeExport).members || [];
        if (members.length > 0 && !members.find((mb) => mb.name === usage.memberName)) {
            diagnostics.push(Diagnostic.create(
                usage.memberRange,
                `"${usage.memberName}" is not a member of "${usage.typeName}"`,
                DiagnosticSeverity.Error,
                undefined,
                "cpx"
            ));
        }

        // Verify EnumType matches the declared prop type on the target component
        const tagExport = resolveImportedSymbol(parsed, usage.tagName);
        if (tagExport && tagExport.props) {
            const prop = tagExport.props.find((p) => p.name === usage.attrName);
            if (prop) {
                const allowedTypes = prop.type
                    .split('|')
                    .map((t) => t.trim().replace(/^\?/, '').replace(/\[\]$/, ''))
                    .filter((t) => /^[A-Z]/.test(t));
                if (allowedTypes.length > 0 && !allowedTypes.includes(usage.typeName)) {
                    diagnostics.push(Diagnostic.create(
                        usage.typeRange,
                        `Prop "${usage.attrName}" expects "${allowedTypes.join(' | ')}", not "${usage.typeName}"`,
                        DiagnosticSeverity.Error,
                        undefined,
                        "cpx"
                    ));
                }
            }
        }
    }

    // 8. Attribute value literal type checking
    //    <MyTag attr={"text"} /> or <MyTag attr="text" /> or <MyTag attr={true} />
    //    — flag when the literal type doesn't match the declared prop type.
    const LITERAL_COMPATIBLE = {
        string:  ['string', 'slot'],  // slot accepts string literals as text content
        boolean: ['boolean'],
        number:  ['number', 'integer']
        // null is handled separately: valid for optional ("?") types and
        // types that explicitly include null.
    };
    for (const usage of parsed.attrValueLiteralUsages) {
        const tagExport = resolveImportedSymbol(parsed, usage.tagName);
        if (!tagExport || !tagExport.props) continue;

        const prop = tagExport.props.find((p) => p.name === usage.attrName);
        if (!prop) continue;

        const rawComponents = prop.type.split('|').map((t) => t.trim());
        const typeComponents = rawComponents
            .map((t) => t.replace(/^\?/, '').replace(/\[\]$/, '').toLowerCase());

        let isCompatible;
        if (usage.literalType === 'null') {
            isCompatible = rawComponents.some((t) => t.startsWith('?')) || typeComponents.includes('null');
        } else {
            const compatible = LITERAL_COMPATIBLE[usage.literalType] || [];
            isCompatible = typeComponents.some((t) => compatible.includes(t));
        }

        if (!isCompatible) {
            diagnostics.push(Diagnostic.create(
                usage.valueRange,
                `Prop "${usage.attrName}" expects "${prop.type}", not a ${usage.literalType} literal`,
                DiagnosticSeverity.Error,
                undefined,
                "cpx"
            ));
        }
    }

    // 10. class={[...]} arrays must contain only strings — component tags are invalid
    for (const err of parseClassArrayErrors(parsed.text)) {
        diagnostics.push(Diagnostic.create(
            err.range,
            err.message,
            DiagnosticSeverity.Error,
            undefined,
            "cpx"
        ));
    }

    return diagnostics;
}

function validateAndPublish(uri, parsed) {
    if (!parsed) {
        connection.sendDiagnostics({ uri, diagnostics: [] });
        return;
    }

    const parserDiagnostics = runCpxCheck(parsed.text);
    // Semantic checks only run on a syntax-clean file, but unused-import
    // warnings are independent of syntax and always run.
    const semanticDiagnostics = parserDiagnostics.length === 0
        ? validateDocument(parsed)
        : unusedImportDiagnostics(parsed);

    connection.sendDiagnostics({
        uri,
        diagnostics: [...parserDiagnostics, ...semanticDiagnostics],
    });
}

connection.onInitialize(async (params) => {
    for (const folder of params.workspaceFolders || []) {
        const fsPath = toFsPath(folder.uri);
        if (fsPath) {
            workspaceRoots.push(fsPath);
        }
    }

    await rebuildIndex();

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            definitionProvider: true,
            hoverProvider: true,
            semanticTokensProvider: {
                legend: semanticTokenLegend,
                full: true
            },
            completionProvider: {
                triggerCharacters: ["<", "{", "\"", "/", ".", " "]
            },
            codeActionProvider: {
                codeActionKinds: ["quickfix"]
            },
            documentOnTypeFormattingProvider: {
                firstTriggerCharacter: ">"
            },
            linkedEditingRangeProvider: true
        }
    };
});

documents.onDidOpen((event) => {
    const fsPath = toFsPath(event.document.uri);
    if (fsPath) {
        indexDocument(fsPath, event.document.getText());
        validateAndPublish(event.document.uri, getDocumentData(event.document.uri));
    }
});

const validateTimers = new Map();
documents.onDidChangeContent((event) => {
    const uri = event.document.uri;
    const fsPath = toFsPath(uri);
    if (!fsPath) return;
    // Index immediately so completions, hover, and definitions stay current.
    indexDocument(fsPath, event.document.getText());
    // Debounce only diagnostics to avoid spurious errors on transient states.
    if (validateTimers.has(uri)) clearTimeout(validateTimers.get(uri));
    validateTimers.set(uri, setTimeout(() => {
        validateTimers.delete(uri);
        validateAndPublish(uri, getDocumentData(uri));
    }, 300));
});

documents.onDidSave((event) => {
    const fsPath = toFsPath(event.document.uri);
    if (fsPath) {
        indexDocument(fsPath, event.document.getText());
        validateAndPublish(event.document.uri, getDocumentData(event.document.uri));
    }
});

documents.onDidClose((event) => {
    connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onDidChangeWatchedFiles(async () => {
    await rebuildIndex();
});

connection.onCodeAction((params) => {
    const actions = [];

    for (const diagnostic of (params.context && params.context.diagnostics) || []) {
        if (diagnostic.code === "missing-import" && diagnostic.data && diagnostic.data.name) {
            const parsed = getDocumentData(params.textDocument.uri);
            if (parsed) {
                const fromPackage = packageForFile(parsed.path);
                const insertAt = importInsertPosition(parsed);
                const seen = new Set();
                for (const definition of exportIndex.get(diagnostic.data.name) || []) {
                    const targetPackage = packageForFile(definition.path);
                    if (fromPackage && !targetPackage) {
                        continue;
                    }
                    const source = buildImportSource(parsed.path, definition.path);
                    if (seen.has(source)) {
                        continue;
                    }
                    seen.add(source);
                    actions.push({
                        title: `Import ${diagnostic.data.name} from "${source}"`,
                        kind: "quickfix",
                        diagnostics: [diagnostic],
                        edit: {
                            changes: {
                                [params.textDocument.uri]: [{
                                    range: Range.create(insertAt, insertAt),
                                    newText: `from "${source}" import { ${diagnostic.data.name} }\n`
                                }]
                            }
                        }
                    });
                }
            }
        }

        if (diagnostic.code === "cross-package-import" && diagnostic.data && diagnostic.data.fix) {
            actions.push({
                title: `Convert to package import "${diagnostic.data.fix}"`,
                kind: "quickfix",
                diagnostics: [diagnostic],
                edit: {
                    changes: {
                        [params.textDocument.uri]: [{
                            range: diagnostic.range,
                            newText: diagnostic.data.fix
                        }]
                    }
                }
            });
        }
    }

    return actions;
});

connection.onDefinition((params) => {
    const parsed = getDocumentData(params.textDocument.uri);
    if (!parsed) {
        return null;
    }

    const word = currentWord(parsed.text, params.position);

    for (const importEntry of parsed.imports) {
        if (isInsideRange(params.position, importEntry.sourceRange)) {
            const resolved = resolveImportPath(parsed.path, importEntry.source);
            if (resolved && fs.existsSync(resolved)) {
                return Location.create(toUri(resolved), Range.create(Position.create(0, 0), Position.create(0, 0)));
            }
        }

        for (const importedName of importEntry.names) {
            if (!isInsideRange(params.position, importedName.range)) {
                continue;
            }

            const resolved = resolveImportPath(parsed.path, importEntry.source);
            if (!resolved) {
                return null;
            }

            const target = documentIndex.get(resolved);
            const exported = target && target.exports.find((entry) => entry.name === importedName.name);
            if (!exported) {
                return null;
            }

            return Location.create(toUri(resolved), exported.range);
        }
    }

    for (const usage of parsed.usages) {
        if (!isInsideRange(params.position, usage.range)) {
            continue;
        }

        const imported = parsed.imports.find((entry) => entry.names.some((item) => item.name === usage.name));
        if (imported) {
            const resolved = resolveImportPath(parsed.path, imported.source);
            const target = resolved ? documentIndex.get(resolved) : null;
            const exported = target && target.exports.find((entry) => entry.name === usage.name);
            if (resolved && exported) {
                return Location.create(toUri(resolved), exported.range);
            }
        }

        const candidates = exportIndex.get(usage.name);
        if (candidates && candidates.length > 0) {
            return Location.create(toUri(candidates[0].path), candidates[0].range);
        }
    }

    if (word && /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
        const imported = parsed.imports.find((entry) => entry.names.some((item) => item.name === word));
        if (imported) {
            const resolved = resolveImportPath(parsed.path, imported.source);
            const target = resolved ? documentIndex.get(resolved) : null;
            const exported = target && target.exports.find((entry) => entry.name === word);
            if (resolved && exported) {
                return Location.create(toUri(resolved), exported.range);
            }
        }

        const localExport = parsed.exports.find((entry) => entry.name === word);
        if (localExport) {
            return Location.create(params.textDocument.uri, localExport.range);
        }

        const candidates = exportIndex.get(word);
        if (candidates && candidates.length > 0) {
            return Location.create(toUri(candidates[0].path), candidates[0].range);
        }
    }

    return null;
});

connection.onCompletion((params) => {
    const parsed = getDocumentData(params.textDocument.uri);
    if (!parsed) {
        return [];
    }

    const text = parsed.text;
    if (isInsideString(text, params.position)) {
        return [];
    }

    // ── Match subject completions ──────────────────────────────────────────
    // Triggered right after the `match` keyword, before the opening `{`.
    // Offers every enum-typed prop as a full match-block snippet.
    const triggerChar = params.context && params.context.triggerCharacter;
    const matchSubject = getMatchSubjectContext(text, params.position);
    const typeContextEarly = isTypeContext(text, params.position);
    const openTagContextEarly = getOpenTagContext(text, params.position);
    const openHtmlTagContextEarly = getOpenHtmlTagContext(text, params.position);
    const htmlTagNameContextEarly = isHtmlTagNameContext(text, params.position);
    // Space is registered as a trigger only to surface match-subject completions
    // and attribute completions inside open tags. Bail for all other space triggers
    // so we don't flood normal typing with unwanted suggestions.
    if (triggerChar === " " && !matchSubject && !typeContextEarly && !openTagContextEarly && !openHtmlTagContextEarly) {
        return [];
    }
    if (matchSubject) {
        const owner = getExportAtPosition(parsed, params.position);
        const items = [];
        for (const prop of (owner && owner.props) || []) {
            if (matchSubject.partial !== "" && matchSubject.partial !== undefined && !prop.name.startsWith(matchSubject.partial)) {
                continue;
            }
            const baseType = prop.type.replace(/^\?/, "").replace(/\[\]$/, "").split(/\s*\|\s*/)[0].trim();
            const enumExport = resolveImportedSymbol(parsed, baseType);
            if (!enumExport || enumExport.kind !== "enum" || !(enumExport.members || []).length) {
                continue;
            }
            const ind = detectIndent(text);
            const arms = enumExport.members.map((m, i) => `${ind}${enumExport.name}.${m.name} -> "\$${i + 1}"`);
            arms.push(`${ind}default -> "$0"`);
            const newText = `match (${prop.name}) {\n${arms.join(",\n")}\n}`;
            items.push({
                label: `match (${prop.name}) { … }`,
                filterText: `match ${prop.name}`,
                kind: CompletionItemKind.Value,
                detail: `Match on ${enumExport.name} — ${enumExport.members.length} arms`,
                textEdit: {
                    range: { start: positionAt(text, matchSubject.matchStart), end: params.position },
                    newText
                },
                insertTextFormat: InsertTextFormat.Snippet,
                insertTextMode: InsertTextMode.adjustIndentation,
                preselect: true,
            });
        }
        if (items.length) return items;
    }

    // ── Match arm autofill ─────────────────────────────────────────────────
    // Triggered right after `match (propName) {` or `match propName {`.
    // If the subject prop resolves to an enum, offer all members as arms.
    const matchBody = getMatchBodyContext(text, params.position);
    if (matchBody) {
        const owner = getExportAtPosition(parsed, params.position);
        // Resolve the subject — could be a direct prop name or a dotted path
        const rootName = matchBody.subject.split(".")[0];
        const prop = owner && owner.props && owner.props.find((p) => p.name === rootName);
        if (prop) {
            // Strip optional marker and array suffix to get the base type name
            const baseType = prop.type.replace(/^\?/, "").replace(/\[\]$/, "").split(/\s*\|\s*/)[0].trim();
            const enumExport = resolveImportedSymbol(parsed, baseType);
            if (enumExport && enumExport.kind === "enum" && (enumExport.members || []).length > 0) {
                return [{
                    label: `${enumExport.name} arms`,
                    kind: CompletionItemKind.Value,
                    detail: `All ${enumExport.members.length} ${enumExport.name} members + default`,
                    insertText: buildMatchArmsSnippet(enumExport, detectIndent(text)),
                    insertTextFormat: InsertTextFormat.Snippet,
                    insertTextMode: InsertTextMode.adjustIndentation,
                    preselect: true,
                }];
            }
        }
        // No enum resolved — offer a generic match arms skeleton
        return [{
            label: "match arms",
            kind: CompletionItemKind.Value,
            detail: "Generic match arm skeleton",
            insertText: "  $1 -> $2,\n  default -> $0\n",
            insertTextFormat: InsertTextFormat.Snippet,
            preselect: true,
        }];
    }

    // PascalCase. → enum member completions (anywhere: match arms, attr values, expressions)
    const pascalMemberAccess = getPascalMemberAccessContext(text, params.position);
    if (pascalMemberAccess) {
        const typeExport = resolveImportedSymbol(parsed, pascalMemberAccess.typeName);
        if (typeExport && typeExport.kind === 'enum') {
            const complete = ensureCompleteExport(typeExport, typeExport.path || parsed.path);
            const members = (complete || typeExport).members || [];
            return members
                .filter((mb) => !pascalMemberAccess.partial || mb.name.toLowerCase().startsWith(pascalMemberAccess.partial.toLowerCase()))
                .map((mb) => ({
                    label: mb.name,
                    kind: CompletionItemKind.EnumMember,
                    detail: `${pascalMemberAccess.typeName}.${mb.name}`,
                    insertText: mb.name,
                    insertTextFormat: InsertTextFormat.PlainText
                }));
        }
        // Cursor is at PascalCase. but it's not a known enum — no completions
        return [];
    }

    const memberAccess = getMemberAccessContext(text, params.position);
    if (memberAccess) {
        const structType = resolveStructForProperty(parsed, params.position, memberAccess.target);
        if (!structType) {
            return [];
        }

        return structType.props
            .filter((prop) => !memberAccess.partial || prop.name.toLowerCase().startsWith(memberAccess.partial.toLowerCase()))
            .map((prop) => ({
                label: prop.name,
                kind: CompletionItemKind.Field,
                detail: prop.type,
                insertText: prop.name
            }));
    }

    const word = currentWord(text, params.position);
    const tagContext = isTagContext(text, params.position);
    const closingTagContext = isClosingTagContext(text, params.position);
    const existingCloseInfo = tagContext ? getExistingCloseTagInfo(text, params.position) : null;
    const openTagContext = getOpenTagContext(text, params.position);
    const typeContext = typeContextEarly;
    const expressionContext = isExpressionContext(text, params.position);

    const openHtmlTagContext = openHtmlTagContextEarly;
    const htmlTagNameContext = htmlTagNameContextEarly;

    if (!tagContext && !typeContext && !expressionContext && !htmlTagNameContext) {
        if (!openTagContext && !openHtmlTagContext) {
            return [];
        }
    }

    const items = [];

    // HTML element attribute completions — delegated to vscode-html-languageservice.
    // It is element-aware: <a> gets href, <img> gets src/alt, etc.
    // Note: expressionContext is always true inside a component body (the body `{` is unclosed),
    // so we can't gate on !expressionContext — instead skip only when inside an attr value brace.
    if (openHtmlTagContext && !tagContext && !closingTagContext && !getAttributeValueContext(text, params.position)) {
        const htmlDoc = TextDocument.create(params.textDocument.uri, "html", 1, text);
        const htmlParsed = htmlService.parseHTMLDocument(htmlDoc);
        const result = htmlService.doComplete(htmlDoc, params.position, htmlParsed);
        return result ? result.items : [];
    }

    // Component attribute-name completions — not inside a `{` value.
    // expressionContext is always true inside a component body, so we check
    // getAttributeValueContext instead: if cursor is in `attr={`, fall through
    // to the expressionContext block; otherwise offer attribute names here.
    if (openTagContext && !tagContext && !closingTagContext && !getAttributeValueContext(text, params.position)) {
        let resolved = resolveImportedSymbol(parsed, openTagContext.tagName);
        let partial = openTagContext.partialAttribute;

        // No-space recovery: user typed directly onto tag name without a space,
        // e.g. <Copycl → tagName='Copycl'. Strip trailing lowercase until we
        // find a known component, accumulating the stripped chars as the partial.
        if (!resolved) {
            let tagName = openTagContext.tagName;
            let stripped = '';
            while (tagName.length > 1 && /[a-z0-9]/.test(tagName[tagName.length - 1])) {
                stripped = tagName[tagName.length - 1] + stripped;
                tagName = tagName.slice(0, -1);
                const candidate = resolveImportedSymbol(parsed, tagName);
                if (candidate && candidate.props) {
                    resolved = candidate;
                    partial = stripped;
                    break;
                }
            }
        }

        if (!resolved || !resolved.props) {
            return [];
        }

        return resolved.props
            .filter((prop) => !partial || prop.name.toLowerCase().startsWith(partial.toLowerCase()))
            .map((prop) => {
                const baseType = prop.type.replace(/^\?/, '').replace(/\[\]$/, '').split(/\s*\|\s*/)[0].trim().toLowerCase();
                const isString = baseType === 'string' || baseType === 'slot';
                return {
                    label: prop.name,
                    kind: CompletionItemKind.Property,
                    detail: prop.type,
                    insertText: isString ? `${prop.name}="$1"` : `${prop.name}={$1}`,
                    insertTextFormat: InsertTextFormat.Snippet,
                    // Re-trigger suggestions immediately after the snippet is accepted
                    // so enum/value options appear without the user having to type first.
                    command: { command: 'editor.action.triggerSuggest', title: '' }
                };
            });
    }

    if (expressionContext) {
        const attrValueCtx = getAttributeValueContext(text, params.position);

        // Enum member suggestions for typed attribute values: tag={HeadlineTag.|}
        // Works for both imported and not-yet-imported enum types — unimported ones
        // get an auto-import additionalTextEdit injected.
        if (attrValueCtx) {
            const tagExport = resolveImportedSymbol(parsed, attrValueCtx.tagName);
            if (tagExport && tagExport.props) {
                const attrProp = tagExport.props.find((p) => p.name === attrValueCtx.attrName);
                if (attrProp) {
                    const typeNames = attrProp.type
                        .split('|')
                        .map((t) => t.trim().replace(/^\?/, '').replace(/\[\]$/, ''))
                        .filter((t) => /^[A-Z]/.test(t));
                    for (const typeName of typeNames) {
                        const typeExport = resolveImportedSymbol(parsed, typeName);
                        if (!typeExport) continue;
                        // Use the enum's own file path so ensureCompleteExport reads
                        // the right file — not the current document's path.
                        const complete = ensureCompleteExport(typeExport, typeExport.path || parsed.path);
                        const members = (complete || typeExport).members || [];
                        if (members.length === 0) continue;

                        // Build auto-import edit if the type is not yet imported
                        const isImported = parsed.imports.some((e) => e.names.some((n) => n.name === typeName));
                        const enumFilePath = typeExport.path;
                        const autoImportEdits = (!isImported && enumFilePath) ? (() => {
                            const src = buildImportSource(parsed.path, enumFilePath);
                            return [{
                                range: Range.create(importInsertPosition(parsed), importInsertPosition(parsed)),
                                newText: `from "${src}" import { ${typeName} }\n`
                            }];
                        })() : undefined;

                        for (const member of members) {
                            const label = `${typeName}.${member.name}`;
                            if (word && !label.toLowerCase().startsWith(word.toLowerCase())) continue;
                            const item = {
                                label,
                                kind: CompletionItemKind.EnumMember,
                                detail: isImported ? `${typeName} member` : `${typeName} member — auto import`,
                                insertText: label,
                                insertTextFormat: InsertTextFormat.PlainText,
                                sortText: `0_${label}`
                            };
                            if (autoImportEdits) item.additionalTextEdits = autoImportEdits;
                            items.push(item);
                        }
                    }
                }
            }
        }

        // Prop name suggestions from the enclosing component
        const owner = getExportAtPosition(parsed, params.position);
        if (owner && owner.props) {
            for (const prop of owner.props) {
                if (word && !prop.name.toLowerCase().startsWith(word.toLowerCase())) {
                    continue;
                }

                items.push({
                    label: prop.name,
                    kind: CompletionItemKind.Property,
                    detail: prop.type,
                    insertText: prop.name
                });
            }
        }

        // Imported enum names — inside a match body, only suggest the match subject's
        // enum so the list stays focused; elsewhere show all imported enums.
        // Skip entirely when inside an attribute value brace — attrValueCtx already
        // handled the right enum members, and we don't want match-subject pollution.
        const activeMatch = !attrValueCtx && getActiveMatchContext(text, params.position);
        if (activeMatch) {
            // Restrict to the specific enum the match is over
            const matchOwner = getExportAtPosition(parsed, params.position);
            const rootName = activeMatch.subject.split('.')[0];
            const subjectProp = matchOwner && matchOwner.props && matchOwner.props.find((p) => p.name === rootName);
            if (subjectProp) {
                const baseType = subjectProp.type.replace(/^\?/, '').replace(/\[\]$/, '').split(/\s*\|\s*/)[0].trim();
                if (/^[A-Z]/.test(baseType)) {
                    const enumExport = resolveImportedSymbol(parsed, baseType);
                    if (enumExport && enumExport.kind === 'enum') {
                        if (!word || baseType.toLowerCase().startsWith(word.toLowerCase())) {
                            items.push({
                                label: baseType,
                                kind: CompletionItemKind.Enum,
                                detail: 'Enum',
                                insertText: baseType,
                                insertTextFormat: InsertTextFormat.PlainText
                            });
                        }
                    }
                }
            }
        } else {
            // Not inside a match — show all imported enums (user can type e.g. "HeadlineT" → "HeadlineTag")
            for (const importEntry of parsed.imports) {
                for (const importedName of importEntry.names) {
                    if (word && !importedName.name.toLowerCase().startsWith(word.toLowerCase())) continue;
                    const resolved = resolveImportedSymbol(parsed, importedName.name);
                    if (!resolved || resolved.kind !== 'enum') continue;
                    items.push({
                        label: importedName.name,
                        kind: CompletionItemKind.Enum,
                        detail: 'Enum',
                        insertText: importedName.name,
                        insertTextFormat: InsertTextFormat.PlainText
                    });
                }
            }
        }
    }

    if (typeContext) {
        const primitives = ["string", "number", "boolean", "slot"];
        for (const prim of primitives) {
            if (word && !prim.startsWith(word.toLowerCase())) continue;
            items.push({
                label: prim,
                kind: CompletionItemKind.TypeParameter,
                detail: "Primitive type",
                insertText: prim,
                insertTextFormat: InsertTextFormat.PlainText,
                sortText: `0_${prim}`
            });
        }
    }

    // HTML tag name completions with proper snippets:
    // void elements (br, img, input…) → self-closing  <br />
    // regular elements (div, span…)   → paired         <div>$0</div>
    if ((tagContext && (!word || /^[a-z]/.test(word))) || htmlTagNameContext) {
        for (const tag of VOID_ELEMENTS) {
            if (word && !tag.startsWith(word.toLowerCase())) continue;
            items.push({
                label: tag,
                kind: CompletionItemKind.Property,
                detail: 'HTML void element',
                insertText: `${tag} />`,
                insertTextFormat: InsertTextFormat.Snippet,
                sortText: `z_${tag}`
            });
        }
        for (const tag of HTML_REGULAR_TAGS) {
            if (word && !tag.startsWith(word.toLowerCase())) continue;
            if (existingCloseInfo) {
                items.push({
                    label: tag,
                    kind: CompletionItemKind.Property,
                    detail: 'HTML element',
                    textEdit: {
                        range: Range.create(
                            positionAt(text, existingCloseInfo.wordStart),
                            positionAt(text, existingCloseInfo.existingCloseTagEnd)
                        ),
                        newText: `${tag}>$0</${tag}>`
                    },
                    insertTextFormat: InsertTextFormat.Snippet,
                    sortText: `z_${tag}`
                });
            } else {
                items.push({
                    label: tag,
                    kind: CompletionItemKind.Property,
                    detail: 'HTML element',
                    insertText: `${tag}>$0</${tag}>`,
                    insertTextFormat: InsertTextFormat.Snippet,
                    sortText: `z_${tag}`
                });
            }
        }
    }

    if (tagContext || typeContext) {
        if (tagContext) {
            for (const candidate of localComponentCandidates(parsed)) {
                if (word && !candidate.name.toLowerCase().startsWith(word.toLowerCase())) {
                    continue;
                }

                if (existingCloseInfo) {
                    items.push({
                        label: candidate.name,
                        kind: CompletionItemKind.Class,
                        detail: "Component",
                        textEdit: {
                            range: Range.create(
                                positionAt(text, existingCloseInfo.wordStart),
                                positionAt(text, existingCloseInfo.existingCloseTagEnd)
                            ),
                            newText: buildComponentSnippet(candidate, false)
                        },
                        insertTextFormat: InsertTextFormat.Snippet,
                        insertTextMode: InsertTextMode.adjustIndentation
                    });
                } else {
                    items.push({
                        label: candidate.name,
                        kind: CompletionItemKind.Class,
                        detail: "Component",
                        insertText: buildComponentSnippet(candidate, closingTagContext),
                        insertTextFormat: InsertTextFormat.Snippet,
                        insertTextMode: InsertTextMode.adjustIndentation
                    });
                }
            }
        }

        for (const candidate of uniqueAutoImportCandidates(parsed, tagContext ? "component" : null)) {
            if (tagContext && candidate.kind !== "component") {
                continue;
            }

            if (word && !candidate.name.toLowerCase().startsWith(word.toLowerCase())) {
                continue;
            }

            const autoImportEdit = [{
                range: Range.create(importInsertPosition(parsed), importInsertPosition(parsed)),
                newText: `from "${candidate.source}" import { ${candidate.name} }\n`
            }];
            if (tagContext && existingCloseInfo) {
                items.push({
                    label: candidate.name,
                    kind: candidate.kind === "enum" ? CompletionItemKind.Enum : CompletionItemKind.Class,
                    detail: `Auto import ${candidate.kind} from ${candidate.source}`,
                    textEdit: {
                        range: Range.create(
                            positionAt(text, existingCloseInfo.wordStart),
                            positionAt(text, existingCloseInfo.existingCloseTagEnd)
                        ),
                        newText: buildComponentSnippet(candidate, false)
                    },
                    insertTextFormat: InsertTextFormat.Snippet,
                    insertTextMode: InsertTextMode.adjustIndentation,
                    additionalTextEdits: autoImportEdit,
                    sortText: `${candidate.samePackage ? "1" : "2"}_${candidate.name}`
                });
            } else {
                items.push({
                    label: candidate.name,
                    kind: candidate.kind === "enum" ? CompletionItemKind.Enum : CompletionItemKind.Class,
                    detail: `Auto import ${candidate.kind} from ${candidate.source}`,
                    insertText: tagContext ? buildComponentSnippet(candidate, closingTagContext) : candidate.name,
                    insertTextFormat: tagContext ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
                    insertTextMode: InsertTextMode.adjustIndentation,
                    additionalTextEdits: autoImportEdit,
                    // Same-package suggestions before cross-package ones with the same name.
                    sortText: `${candidate.samePackage ? "1" : "2"}_${candidate.name}`
                });
            }
            // Any importable type can be wrapped in a `list<…>` collection type —
            // but not when we're already typing the item type of one (avoids
            // offering a nonsensical `list<list<Foo>>` double-wrap).
            if (typeContext && !tagContext && !isInsideGenericTypeArgument(text, params.position)) {
                items.push({
                    label: `list<${candidate.name}>`,
                    kind: CompletionItemKind.Class,
                    detail: `Auto import list<${candidate.kind}> from ${candidate.source}`,
                    insertText: `list<${candidate.name}>`,
                    insertTextFormat: InsertTextFormat.PlainText,
                    additionalTextEdits: autoImportEdit
                });
            }
        }
    }

    return items;
});

// Finds the offset of the matching </> for a <> at openTagPos (the < character).
function findMatchingCloseFragment(text, openTagPos) {
    const re = /<(\/?)\s*>/g;
    re.lastIndex = openTagPos + 2; // skip past the <> itself
    let depth = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
        if (match[1] === '/') {
            if (depth === 0) return match.index;
            depth--;
        } else {
            depth++;
        }
    }
    return null;
}

// Finds the offset of the matching <> for a </> whose < is at closeTagPos.
function findMatchingOpenFragment(text, closeTagPos) {
    const re = /<(\/?)\s*>/g;
    const matches = [];
    let match;
    while ((match = re.exec(text)) !== null) {
        if (match.index >= closeTagPos) break;
        matches.push({ index: match.index, isClose: match[1] === '/' });
    }
    let depth = 0;
    for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        if (m.isClose) {
            depth++;
        } else {
            if (depth === 0) return m.index;
            depth--;
        }
    }
    return null;
}

// Returns the offset of the tag name inside the matching closing </tagName>,
// scanning forward from scanFrom, respecting nesting depth.
function findMatchingCloseTag(text, scanFrom, tagName) {
    const re = new RegExp(`<(/?)(${tagName})(?=[\\s/>])`, 'gi');
    re.lastIndex = scanFrom;
    let depth = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
        if (match[1] === '/') {
            if (depth === 0) return match.index + 2; // offset of tag name after </
            depth--;
        } else {
            // Only count non-self-closing opens
            const tail = text.slice(match.index + match[0].length);
            if (!/^\s*\/>/.test(tail)) depth++;
        }
    }
    return null;
}

// Returns the offset of the tag name inside the matching opening <tagName>,
// scanning backward from scanFrom.
function findMatchingOpenTag(text, scanFrom, tagName) {
    const re = new RegExp(`<(/?)(${tagName})(?=[\\s/>])`, 'gi');
    let depth = 0;
    let lastOpen = null;
    let match;
    re.lastIndex = 0;
    // Collect all matches up to scanFrom, then walk backwards
    const matches = [];
    while ((match = re.exec(text)) !== null) {
        if (match.index >= scanFrom) break;
        matches.push({ index: match.index, isClose: match[1] === '/' });
    }
    for (let i = matches.length - 1; i >= 0; i--) {
        const m = matches[i];
        if (m.isClose) {
            depth++;
        } else {
            if (depth === 0) return m.index + 1; // offset of tag name after <
            depth--;
        }
    }
    return null;
}

connection.languages.onLinkedEditingRange((params) => {
    const parsed = getDocumentData(params.textDocument.uri);
    if (!parsed) return null;

    const text = parsed.text;
    const offset = offsetAt(text, params.position);

    // Find word boundaries around cursor (tag name characters)
    let start = offset;
    while (start > 0 && /[A-Za-z0-9_:-]/.test(text[start - 1])) start--;
    let end = offset;
    while (end < text.length && /[A-Za-z0-9_:-]/.test(text[end])) end++;

    if (start === end) {
        // Fragment case: cursor is inside <> or </> with no tag name yet
        const before = text.slice(0, offset);
        const after = text.slice(offset);
        if (before.endsWith('<') && after.startsWith('>')) {
            // Cursor inside opening fragment <|>
            const openTagPos = offset - 1;
            const closeTagPos = findMatchingCloseFragment(text, openTagPos);
            if (closeTagPos === null) return null;
            // Insert point inside </> is after the /  (closeTagPos + 2)
            return { ranges: [
                makeRange(text, offset, offset),
                makeRange(text, closeTagPos + 2, closeTagPos + 2)
            ]};
        }
        if (before.endsWith('</') && after.startsWith('>')) {
            // Cursor inside closing fragment </|>
            const closeTagPos = offset - 2;
            const openTagPos = findMatchingOpenFragment(text, closeTagPos);
            if (openTagPos === null) return null;
            // Insert point inside <> is after the < (openTagPos + 1)
            return { ranges: [
                makeRange(text, openTagPos + 1, openTagPos + 1),
                makeRange(text, offset, offset)
            ]};
        }
        return null;
    }

    const tagName = text.slice(start, end);
    const before = text.slice(0, start);
    const isOpenTag = before.endsWith('<');
    const isCloseTag = before.endsWith('</');

    if (!isOpenTag && !isCloseTag) return null;
    if (VOID_ELEMENTS.has(tagName.toLowerCase())) return null;

    const currentRange = makeRange(text, start, end);

    if (isOpenTag) {
        const matchOffset = findMatchingCloseTag(text, start, tagName);
        if (matchOffset === null) return { ranges: [currentRange] };
        return { ranges: [currentRange, makeRange(text, matchOffset, matchOffset + tagName.length)] };
    } else {
        const matchOffset = findMatchingOpenTag(text, start - 2, tagName); // -2 for </
        if (matchOffset === null) return { ranges: [currentRange] };
        return { ranges: [makeRange(text, matchOffset, matchOffset + tagName.length), currentRange] };
    }
});

connection.onDocumentOnTypeFormatting((params) => {
    const parsed = getDocumentData(params.textDocument.uri);
    if (!parsed) return null;

    if (params.ch === '>') {
        const tagName = getAutoCloseTagName(parsed.text, params.position);
        if (tagName !== null) {
            return [{
                range: Range.create(params.position, params.position),
                newText: tagName === '' ? '</>' : `</${tagName}>`
            }];
        }
    }

    return null;
});

connection.onHover((params) => {
    const parsed = getDocumentData(params.textDocument.uri);
    if (!parsed) {
        return null;
    }

    const word = currentWord(parsed.text, params.position);
    const componentProp = resolveComponentPropAtPosition(parsed, params.position, word);
    if (componentProp) {
        return buildHoverForProperty(componentProp.prop, componentProp.ownerParsed);
    }

    const localProp = resolvePropertyAtPosition(parsed, params.position, word);
    if (localProp) {
        return buildHoverForProperty(localProp, parsed);
    }

    for (const usage of parsed.usages) {
        if (!isInsideRange(params.position, usage.range)) {
            continue;
        }

        const imported = parsed.imports.find((entry) => entry.names.some((item) => item.name === usage.name));
        if (imported) {
            const exported = resolveSymbolExport(parsed, usage.name);
            if (exported) {
                return buildHoverForExport(exported);
            }
        }
        const exported = resolveSymbolExport(parsed, usage.name);
        if (exported) {
            return buildHoverForExport(exported);
        }
    }

    for (const usage of parsed.typeUsages) {
        if (!isInsideRange(params.position, usage.range)) {
            continue;
        }

        const exported = resolveSymbolExport(parsed, usage.name);
        if (exported) {
            return buildHoverForExport(exported);
        }
    }

    for (const usage of parsed.enumMemberUsages || []) {
        if (!isInsideRange(params.position, usage.range)) {
            continue;
        }

        const exported = resolveSymbolExport(parsed, usage.owner);
        if (exported) {
            return buildHoverForExport(exported);
        }
    }

    for (const importEntry of parsed.imports) {
        for (const importedName of importEntry.names) {
            if (!isInsideRange(params.position, importedName.range)) {
                continue;
            }

            const exported = resolveSymbolExport(parsed, importedName.name);
            if (exported) {
                return buildHoverForExport(exported);
            }
        }
    }

    if (word && /^[A-Z][A-Za-z0-9_]*$/.test(word)) {
        const exported = resolveSymbolExport(parsed, word);
        if (exported) {
            return buildHoverForExport(exported);
        }
    }

    return null;
});

connection.languages.semanticTokens.on((params) => {
    const parsed = getDocumentData(params.textDocument.uri);
    if (!parsed) {
        return { data: [] };
    }

    return collectSemanticTokens(parsed);
});

documents.listen(connection);
connection.listen();
