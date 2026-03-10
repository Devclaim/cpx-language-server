"use strict";

const fs = require("fs");
const path = require("path");
const {
    createConnection,
    TextDocuments,
    ProposedFeatures,
    SemanticTokensBuilder,
    TextDocumentSyncKind,
    CompletionItemKind,
    InsertTextFormat,
    InsertTextMode,
    Location,
    Position,
    Range
} = require("vscode-languageserver/node");
const { TextDocument } = require("vscode-languageserver-textdocument");

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

const workspaceRoots = [];
const documentIndex = new Map();
const exportIndex = new Map();
const semanticTokenLegend = {
    tokenTypes: ["class", "enum"],
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
            props: kind === "component" || kind === "struct"
                ? parsePropertyDeclarations(text.slice(blockStart + 1, blockEnd))
                : []
        });
    }

    return exports;
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

function parsePropertyDeclarations(blockText) {
    const props = [];
    const propertyRegex = /^\s*([a-z][A-Za-z0-9_]*)\s*:\s*(\??(?:slot|boolean|string|number|[A-Z][A-Za-z0-9_]*)(?:\s*\|\s*\??(?:slot|boolean|string|number|[A-Z][A-Za-z0-9_]*))*)\s*$/gm;
    let match;

    while ((match = propertyRegex.exec(blockText))) {
        props.push({
            name: match[1],
            type: match[2]
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

function indexDocument(fsPath, text) {
    const normalized = normalizePath(fsPath);
    const parsed = {
        path: normalized,
        imports: parseImports(text),
        exports: parseExports(text),
        usages: parseComponentUsages(text),
        typeUsages: parseTypeUsages(text),
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

        if ((char === "\"" || char === "'" || char === "`") && prev !== "\\") {
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

function collectSemanticTokens(parsed) {
    const builder = new SemanticTokensBuilder();
    const tokenKinds = new Map();

    for (const exported of parsed.exports) {
        tokenKinds.set(exported.name, exported.kind);
        builder.push(
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
            builder.push(
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
        builder.push(
            usage.range.start.line,
            usage.range.start.character,
            usage.range.end.character - usage.range.start.character,
            tokenTypeIndex(kind),
            0
        );
    }

    for (const usage of parsed.typeUsages) {
        const kind = tokenKinds.get(usage.name) || (exportIndex.get(usage.name)?.[0]?.kind) || "component";
        builder.push(
            usage.range.start.line,
            usage.range.start.character,
            usage.range.end.character - usage.range.start.character,
            tokenTypeIndex(kind),
            0
        );
    }

    return builder.build();
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
    }
});

documents.onDidChangeContent((event) => {
    const fsPath = toFsPath(event.document.uri);
    if (fsPath) {
        indexDocument(fsPath, event.document.getText());
    }
});

documents.onDidSave((event) => {
    const fsPath = toFsPath(event.document.uri);
    if (fsPath) {
        indexDocument(fsPath, event.document.getText());
    }
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
    const typeContext = isTypeContext(text, params.position);
    const expressionContext = isExpressionContext(text, params.position);

    if (!tagContext && !typeContext && !expressionContext) {
        return [];
    }

    const items = [];

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

connection.languages.semanticTokens.on((params) => {
    const parsed = getDocumentData(params.textDocument.uri);
    if (!parsed) {
        return { data: [] };
    }

    return collectSemanticTokens(parsed);
});

documents.listen(connection);
connection.listen();
