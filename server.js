"use strict";

const fs = require("fs");
const path = require("path");
const { parseCPX, parseCPXNodes } = require("./cpxParser.js");
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
    DiagnosticSeverity
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const workspaceRoots = [];
const documentIndex = new Map();
const exportIndex = new Map();
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

function parsePropertyDeclarations(blockText, baseOffset = 0, fullText = blockText) {
    const props = [];
    const propertyRegex = /^\s*([a-z][A-Za-z0-9_]*)\s*:\s*(\??(?:slot|boolean|string|number|[A-Z][A-Za-z0-9_]*)(?:\[\])?(?:\s*\|\s*\??(?:slot|boolean|string|number|[A-Z][A-Za-z0-9_]*)(?:\[\])?)*)\s*$/gm;
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
        const typeRegex = /\??([A-Z][A-Za-z0-9_]*)/g;
        let typeMatch;

        while ((typeMatch = typeRegex.exec(typesText))) {
            const name = typeMatch[1];
            const startOffset = baseOffset + typeMatch.index + typeMatch[0].lastIndexOf(name);
            usages.push({
                name,
                range: makeRange(text, startOffset, startOffset + name.length)
            });
        }
    }

    return usages;
}

function parseEnumMemberUsages(text) {
    const usages = [];
    const enumRegex = /\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let match;

    while ((match = enumRegex.exec(text))) {
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

function indexDocument(fsPath, text) {
    const normalized = normalizePath(fsPath);
    const parsed = {
        path: normalized,
        imports: parseImports(text),
        exports: parseExports(text),
        usages: parseComponentUsages(text),
        typeUsages: parseTypeUsages(text),
        enumMemberUsages: parseEnumMemberUsages(text),
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

function resolveImportPath(fromFile, importPath) {
    if (!importPath.startsWith(".")) {
        return null;
    }

    const resolved = normalizePath(path.resolve(path.dirname(fromFile), importPath));
    return path.extname(resolved) ? resolved : `${resolved}.cpx`;
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
    return /:\s*(?:\??[A-Z]?[A-Za-z0-9_]*\s*\|\s*)*\??[A-Z]?[A-Za-z0-9_]*$/.test(prefix);
}

function isTagContext(text, position) {
    const offset = offsetAt(text, position);
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    return /<[/]?[A-Z][A-Za-z0-9_]*$/.test(prefix) || /<$/.test(prefix);
}

function isClosingTagContext(text, position) {
    const offset = offsetAt(text, position);
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    return /<\/[A-Z][A-Za-z0-9_]*$/.test(prefix) || /<\/$/.test(prefix);
}

function getOpenTagContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const tagStart = left.lastIndexOf("<");
    if (tagStart === -1) {
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
function buildMatchArmsSnippet(enumExport) {
    const name = enumExport.name;
    const members = enumExport.members || [];
    const lines = members.map((m, i) => `  ${name}.${m.name} -> $${i + 1}`);
    lines.push("  default -> $0");
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

function uniqueAutoImportCandidates(parsed, preferredKind) {
    const importedNames = new Set(parsed.imports.flatMap((entry) => entry.names.map((item) => item.name)));
    const localExports = new Set(parsed.exports.map((entry) => entry.name));
    const seen = new Set();
    const items = [];

    for (const [name, definitions] of exportIndex.entries()) {
        if (importedNames.has(name) || localExports.has(name) || seen.has(name)) {
            continue;
        }

        const preferred = definitions.find((definition) => definition.kind === preferredKind) || definitions[0];
        const relativePath = path.relative(path.dirname(parsed.path), preferred.path).replace(/\\/g, "/");
        const source = relativePath.startsWith(".") ? relativePath : `./${relativePath}`;

        seen.add(name);
        items.push({
            name,
            kind: preferred.kind,
            props: preferred.props,
            source
        });
    }

    return items.sort((a, b) => a.name.localeCompare(b.name));
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

function validateDocument(parsed) {
    const diagnostics = [];

    // 1. Import paths and exported names
    for (const importEntry of parsed.imports) {
        const resolved = resolveImportPath(parsed.path, importEntry.source);
        if (resolved === null) {
            continue; // non-relative import, skip
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

    // 2. Component tag usages — must be imported or locally declared
    for (const usage of parsed.usages) {
        if (!resolveImportedSymbol(parsed, usage.name)) {
            diagnostics.push(Diagnostic.create(
                usage.range,
                `"${usage.name}" is not imported or declared`,
                DiagnosticSeverity.Warning,
                undefined,
                "cpx"
            ));
        }
    }

    // 3. Type usages in property declarations — must be imported or locally declared
    for (const usage of parsed.typeUsages) {
        if (PRIMITIVE_TYPES.has(usage.name.toLowerCase())) {
            continue;
        }
        if (!resolveImportedSymbol(parsed, usage.name)) {
            diagnostics.push(Diagnostic.create(
                usage.range,
                `Type "${usage.name}" is not imported or declared`,
                DiagnosticSeverity.Warning,
                undefined,
                "cpx"
            ));
        }
    }

    // 4. Components must have a render block
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

    return diagnostics;
}

function validateAndPublish(uri, parsed) {
    if (!parsed) {
        connection.sendDiagnostics({ uri, diagnostics: [] });
        return;
    }

    const parserDiagnostics = runCpxCheck(parsed.text);
    const semanticDiagnostics = parserDiagnostics.length === 0
        ? validateDocument(parsed)   // only run semantic checks when syntax is clean
        : [];

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
                triggerCharacters: ["<", "{", "\"", "/", "."]
            }
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

documents.onDidChangeContent((event) => {
    const fsPath = toFsPath(event.document.uri);
    if (fsPath) {
        indexDocument(fsPath, event.document.getText());
        validateAndPublish(event.document.uri, getDocumentData(event.document.uri));
    }
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
                    kind: CompletionItemKind.Snippet,
                    detail: `All ${enumExport.members.length} ${enumExport.name} members + default`,
                    insertText: buildMatchArmsSnippet(enumExport),
                    insertTextFormat: InsertTextFormat.Snippet,
                    insertTextMode: InsertTextMode.adjustIndentation,
                    preselect: true,
                }];
            }
        }
        // No enum resolved — offer a generic match arms skeleton
        return [{
            label: "match arms",
            kind: CompletionItemKind.Snippet,
            detail: "Generic match arm skeleton",
            insertText: "  $1 -> $2,\n  default -> $0\n",
            insertTextFormat: InsertTextFormat.Snippet,
            preselect: true,
        }];
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
    const openTagContext = getOpenTagContext(text, params.position);
    const typeContext = isTypeContext(text, params.position);
    const expressionContext = isExpressionContext(text, params.position);

    if (!tagContext && !typeContext && !expressionContext) {
        if (!openTagContext) {
            return [];
        }
    }

    const items = [];

    if (openTagContext && !tagContext && !closingTagContext) {
        const resolved = resolveImportedSymbol(parsed, openTagContext.tagName);
        if (!resolved || !resolved.props) {
            return [];
        }

        return resolved.props
            .filter((prop) => !openTagContext.partialAttribute || prop.name.toLowerCase().startsWith(openTagContext.partialAttribute.toLowerCase()))
            .map((prop) => ({
                label: prop.name,
                kind: CompletionItemKind.Property,
                detail: prop.type,
                insertText: `${prop.name}=`,
                insertTextFormat: InsertTextFormat.PlainText
            }));
    }

    if (expressionContext) {
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
    }

    if (tagContext || typeContext) {
        if (tagContext) {
            for (const candidate of localComponentCandidates(parsed)) {
                if (word && !candidate.name.toLowerCase().startsWith(word.toLowerCase())) {
                    continue;
                }

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

        for (const candidate of uniqueAutoImportCandidates(parsed, tagContext ? "component" : null)) {
            if (tagContext && candidate.kind !== "component") {
                continue;
            }

            if (word && !candidate.name.toLowerCase().startsWith(word.toLowerCase())) {
                continue;
            }

            items.push({
                label: candidate.name,
                kind: candidate.kind === "enum" ? CompletionItemKind.Enum : CompletionItemKind.Class,
                detail: `Auto import ${candidate.kind} from ${candidate.source}`,
                insertText: tagContext ? buildComponentSnippet(candidate, closingTagContext) : candidate.name,
                insertTextFormat: tagContext ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
                insertTextMode: InsertTextMode.adjustIndentation,
                additionalTextEdits: [
                    {
                        range: Range.create(importInsertPosition(parsed), importInsertPosition(parsed)),
                        newText: `from "${candidate.source}" import { ${candidate.name} }\n`
                    }
                ]
            });
        }
    }

    return items;
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
