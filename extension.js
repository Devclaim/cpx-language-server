"use strict";

const path = require("path");
const vscode = require("vscode");
const { LanguageClient, TransportKind } = require("vscode-languageclient/node");

let client;
const semanticLegend = new vscode.SemanticTokensLegend(["class", "enum"], ["declaration"]);

function parseImports(text) {
    const imports = [];
    const importRegex = /^\s*from\s+"([^"]+)"\s+import\s+\{([^}]+)\}/gm;
    let match;

    while ((match = importRegex.exec(text))) {
        const names = match[2]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean);
        imports.push(...names.map((name) => ({ name, kind: "class" })));
    }

    return imports;
}

function parseExports(text) {
    const exports = [];
    const exportRegex = /^\s*export\s+(component|struct|enum)\s+([A-Z][A-Za-z0-9_]*)/gm;
    let match;

    while ((match = exportRegex.exec(text))) {
        exports.push({
            name: match[2],
            kind: match[1] === "enum" ? "enum" : "class",
            declaration: true
        });
    }

    return exports;
}

function collectMatches(text, regex) {
    const matches = [];
    let match;

    while ((match = regex.exec(text))) {
        matches.push({
            text: match[1],
            index: match.index + match[0].lastIndexOf(match[1])
        });
    }

    return matches;
}

function positionAt(text, offset) {
    const lines = text.slice(0, offset).split(/\r?\n/);
    return new vscode.Position(lines.length - 1, lines[lines.length - 1].length);
}

function buildSemanticTokens(document) {
    const text = document.getText();
    const builder = new vscode.SemanticTokensBuilder(semanticLegend);
    const knownKinds = new Map();

    for (const entry of parseImports(text)) {
        knownKinds.set(entry.name, entry.kind);
    }

    for (const entry of parseExports(text)) {
        knownKinds.set(entry.name, entry.kind);
        const exportRegex = new RegExp(`\\b${entry.name}\\b`, "g");
        const exportMatch = exportRegex.exec(text);
        if (!exportMatch) {
            continue;
        }
        const position = positionAt(text, exportMatch.index);
        builder.push(position.line, position.character, entry.name.length, entry.kind === "enum" ? 1 : 0, 1);
    }

    for (const match of collectMatches(text, /<([A-Z][A-Za-z0-9_]*)\b/g)) {
        const kind = knownKinds.get(match.text) || "class";
        const position = positionAt(text, match.index);
        builder.push(position.line, position.character, match.text.length, kind === "enum" ? 1 : 0, 0);
    }

    for (const match of collectMatches(text, /<\/([A-Z][A-Za-z0-9_]*)\b/g)) {
        const kind = knownKinds.get(match.text) || "class";
        const position = positionAt(text, match.index);
        builder.push(position.line, position.character, match.text.length, kind === "enum" ? 1 : 0, 0);
    }

    for (const match of collectMatches(text, /^\s*[a-z][A-Za-z0-9_]*\s*:\s*([^\n]+)/gm)) {
        const typeRegex = /\??([A-Z][A-Za-z0-9_]*)/g;
        let typeMatch;
        while ((typeMatch = typeRegex.exec(match.text))) {
            const typeName = typeMatch[1];
            const typeOffset = match.index + typeMatch.index + typeMatch[0].lastIndexOf(typeName);
            const kind = knownKinds.get(typeName) || "class";
            const position = positionAt(text, typeOffset);
            builder.push(position.line, position.character, typeName.length, kind === "enum" ? 1 : 0, 0);
        }
    }

    return builder.build();
}

function activate(context) {
    const serverModule = context.asAbsolutePath(path.join("server.js"));
    const serverOptions = {
        run: {
            module: serverModule,
            transport: TransportKind.ipc
        },
        debug: {
            module: serverModule,
            transport: TransportKind.ipc,
            options: {
                execArgv: ["--nolazy", "--inspect=6009"]
            }
        }
    };

    const clientOptions = {
        documentSelector: [{ scheme: "file", language: "cpx" }],
        synchronize: {
            fileEvents: vscode.workspace.createFileSystemWatcher("**/*.cpx")
        }
    };

    client = new LanguageClient(
        "cpxLanguageServer",
        "CPX Language Server",
        serverOptions,
        clientOptions
    );

    context.subscriptions.push(client.start());
    context.subscriptions.push(
        vscode.languages.registerDocumentSemanticTokensProvider(
            { language: "cpx", scheme: "file" },
            {
                provideDocumentSemanticTokens(document) {
                    return buildSemanticTokens(document);
                }
            },
            semanticLegend
        )
    );
}

function deactivate() {
    if (!client) {
        return undefined;
    }

    return client.stop();
}

module.exports = {
    activate,
    deactivate
};
