'use strict';

/**
 * Integration tests that load the real server.js in-process and drive its
 * actual connection.onCompletion handler — unlike server.test.js, which
 * mostly re-tests standalone copies of server.js's internal logic. Those
 * copies can drift from the real implementation silently; this file exists
 * to catch that class of regression (e.g. a feature that works in its
 * isolated helper but is unreachable through the real completion request).
 *
 * The LSP transport (vscode-languageserver/node, vscode-languageserver-
 * textdocument, vscode-html-languageservice) is mocked so server.js can be
 * required without an actual client/connection.
 *
 * Run with:  node server.integration.test.js
 */

const path = require('path');
const Module = require('module');

const SERVER_PATH = path.join(__dirname, 'server.js');

const handlers = {};
let documentsOpenHandler = null;
let documentsChangeHandler = null;
const docs = new Map();

class FakeTextDocuments {
    listen() {}
    get(uri) { return docs.get(uri); }
    onDidChangeContent(fn) { documentsChangeHandler = fn; }
    onDidOpen(fn) { documentsOpenHandler = fn; }
    onDidSave() {}
    onDidClose() {}
}

function makeTextDocument(uri, text) {
    const lines = text.split('\n');
    return {
        uri,
        getText: () => text,
        positionAt(offset) {
            let line = 0, col = 0, count = 0;
            for (; line < lines.length; line++) {
                if (count + lines[line].length >= offset) { col = offset - count; break; }
                count += lines[line].length + 1;
            }
            return { line, character: col };
        },
        offsetAt(pos) {
            let offset = 0;
            for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
            return offset + pos.character;
        }
    };
}

const known = {
    console: { error: () => {}, log: () => {}, warn: () => {}, info: () => {} },
    onCompletion: (fn) => { handlers.onCompletion = fn; },
    onHover: (fn) => { handlers.onHover = fn; },
    onDefinition: (fn) => { handlers.onDefinition = fn; },
    onCodeAction: (fn) => { handlers.onCodeAction = fn; },
    sendDiagnostics: () => {},
    listen: () => {},
    workspace: { getConfiguration: async () => ({}) },
};

// Any connection.onXxx / connection.languages.onXxx registration we didn't
// explicitly stub above becomes a captured no-op via this proxy, so adding
// new LSP features to server.js never breaks this harness.
function makeBottomlessProxy(name) {
    const fn = (handlerFn) => { handlers[name] = handlerFn; };
    return new Proxy(fn, {
        get(target, prop) {
            if (prop === 'then') return undefined;
            return makeBottomlessProxy(`${name}.${String(prop)}`);
        }
    });
}
const fakeConnection = new Proxy(known, {
    get(target, prop) {
        if (prop in target) return target[prop];
        return makeBottomlessProxy(String(prop));
    }
});

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'vscode-languageserver/node') {
        return {
            createConnection: () => fakeConnection,
            TextDocuments: FakeTextDocuments,
            ProposedFeatures: { all: {} },
            TextDocumentSyncKind: { Incremental: 2 },
            CompletionItemKind: new Proxy({}, { get: (_, k) => k }),
            InsertTextFormat: { PlainText: 1, Snippet: 2 },
            InsertTextMode: { asIs: 1, adjustIndentation: 2 },
            DiagnosticSeverity: { Error: 1, Warning: 2, Information: 3, Hint: 4 },
            SemanticTokensBuilder: class { build() { return { data: [] }; } },
            CodeActionKind: { QuickFix: 'quickfix' },
            MarkupKind: { PlainText: 'plaintext', Markdown: 'markdown' },
            Position: { create: (line, character) => ({ line, character }) },
            Range: { create: (start, end) => ({ start, end }) },
            Location: { create: (uri, range) => ({ uri, range }) },
            Diagnostic: { create: (range, message, severity, code) => ({ range, message, severity, code }) },
            DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
        };
    }
    if (request === 'vscode-languageserver-textdocument') {
        return { TextDocument: { create: (uri, lang, version, text) => makeTextDocument(uri, text) } };
    }
    if (request === 'vscode-html-languageservice') {
        return { getLanguageService: () => ({}) };
    }
    return origLoad.apply(this, arguments);
};
require(SERVER_PATH);
Module._load = origLoad;

function openDocument(uri, text) {
    const doc = makeTextDocument(uri, text);
    docs.set(uri, doc);
    if (documentsOpenHandler) documentsOpenHandler({ document: doc });
    return doc;
}

/** Opens `text` with `cursorMarker` (default "@") removed, returning its position. */
function openWithCursor(uri, text, cursorMarker = '@') {
    const idx = text.indexOf(cursorMarker);
    if (idx === -1) throw new Error(`cursor marker ${JSON.stringify(cursorMarker)} not found`);
    const clean = text.slice(0, idx) + text.slice(idx + cursorMarker.length);
    const before = clean.slice(0, idx);
    const lines = before.split('\n');
    const position = { line: lines.length - 1, character: lines[lines.length - 1].length };
    openDocument(uri, clean);
    return position;
}

function complete(uri, position, triggerCharacter) {
    return handlers.onCompletion({
        textDocument: { uri },
        position,
        context: triggerCharacter ? { triggerCharacter } : undefined,
    });
}

function typeFormat(uri, position, ch) {
    return handlers.onDocumentOnTypeFormatting({ textDocument: { uri }, position, ch });
}

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function it(label, fn) {
    try {
        fn();
        console.log(`  ✓  ${label}`);
        passed++;
    } catch (e) {
        console.log(`  ✗  ${label}`);
        console.log(`       ${e.message}`);
        failed++;
    }
}

function assert(cond, msg) {
    if (!cond) throw new Error(msg || 'assertion failed');
}

const STATUS_ENUM = `export enum Status {\n  ACTIVE\n  INACTIVE\n}`;

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Match arm autofill (real onCompletion) ───────────────────────────────');

it('plain enum prop offers enum-specific arms', () => {
    openDocument('file:///t/Status.cpx', STATUS_ENUM);
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `from "./Status.cpx" import { Status }\nexport component X {\n  status: Status\n  render match (status) {@}\n}`);
    const result = complete(uri, pos, '{');
    assert(result.length === 1, `expected 1 item, got ${result.length}`);
    assert(result[0].label === 'Status arms', `unexpected label: ${result[0].label}`);
    assert(result[0].insertText.includes('Status.ACTIVE'));
    assert(result[0].insertText.includes('Status.INACTIVE'));
    assert(result[0].insertText.includes('default'));
});

it('optional enum prop (?Status) offers enum-specific arms', () => {
    openDocument('file:///t/Status.cpx', STATUS_ENUM);
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `from "./Status.cpx" import { Status }\nexport component X {\n  status: ?Status\n  render match (status) {@}\n}`);
    const result = complete(uri, pos, '{');
    assert(result.length === 1 && result[0].label === 'Status arms');
});

it('union enum prop (Status | slot) offers enum-specific arms', () => {
    openDocument('file:///t/Status.cpx', STATUS_ENUM);
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `from "./Status.cpx" import { Status }\nexport component X {\n  status: Status | slot\n  render match (status) {@}\n}`);
    const result = complete(uri, pos, '{');
    assert(result.length === 1 && result[0].label === 'Status arms');
});

it('match nested inside an attribute expression array (real distribution shape)', () => {
    // Mirrors Vendor.Shared/Components/Block/Headline/Headline.cpx:
    // a multi-line render body with `match` nested inside `class={[...]}`.
    openDocument('file:///t/Size.cpx', `export enum Size {\n  SM\n  LG\n}`);
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(
        uri,
        `from "./Size.cpx" import { Size }\n` +
        `export component X {\n` +
        `    size: Size\n\n` +
        `    render\n` +
        `        <element\n` +
        `            class={[\n` +
        `                "w-full",\n` +
        `                match (size) {@}\n` +
        `            ]}\n` +
        `        />\n` +
        `}`
    );
    const result = complete(uri, pos, '{');
    assert(result.length === 1 && result[0].label === 'Size arms', `got ${JSON.stringify(result)}`);
});

it('list<Status> prop is recognized (no longer silently dropped)', () => {
    // Before the alpha4/5 `list<T>` fix, list-typed props weren't matched by
    // parsePropertyDeclarations's regex at all, so `owner.props` never
    // contained them. `match` doesn't apply to a list as a whole, so no
    // enum-specific arms are expected — but the prop must now be *found*
    // (proven indirectly: no crash, and the generic fallback is reached
    // through the "prop found, base type doesn't resolve to an enum" path
    // rather than "prop not found at all").
    openDocument('file:///t/Status.cpx', STATUS_ENUM);
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `from "./Status.cpx" import { Status }\nexport component X {\n  items: list<Status>\n  render match (items) {@}\n}`);
    const result = complete(uri, pos, '{');
    assert(result.length === 1, `expected fallback skeleton, got ${JSON.stringify(result)}`);
    assert(result[0].label === 'match arms');
});

it('unresolvable subject still offers the generic fallback skeleton', () => {
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `export component X {\n  render match (whatever) {@}\n}`);
    const result = complete(uri, pos, '{');
    assert(result.length === 1 && result[0].label === 'match arms');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Auto-import collection-type suggestion ───────────────────────────────');

it('offers list<Type> (not the invalid Type[]) when importing into a type position', () => {
    openDocument('file:///t/Button.cpx', `export component Button {\n  render <button/>\n}`);
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `export component X {\n  items: But@\n  render <div/>\n}`);
    const result = complete(uri, pos);
    const collectionItem = result.find((i) => i.label.startsWith('list<'));
    assert(collectionItem, `no list<> suggestion in ${JSON.stringify(result)}`);
    assert(collectionItem.label === 'list<Button>');
    assert(collectionItem.insertText === 'list<Button>');
    assert(!result.some((i) => i.label.includes('[]')), 'no suggestion should offer the old Type[] syntax');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Auto-close on typing ">" ──────────────────────────────────────────────');

it('does NOT auto-close a generic type argument list (list<AccordionItem>)', () => {
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `export component X {\n  content: list<AccordionItem>@\n  render <div/>\n}`);
    const result = typeFormat(uri, pos, '>');
    assert(result === null, `expected no edit, got ${JSON.stringify(result)}`);
});

it('does NOT auto-close a nested generic (list<list<Foo>>)', () => {
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `export component X {\n  items: list<list<Foo>>@\n  render <div/>\n}`);
    const result = typeFormat(uri, pos, '>');
    assert(result === null, `expected no edit, got ${JSON.stringify(result)}`);
});

it('still auto-closes a real component tag (<AccordionItem>)', () => {
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `export component X {\n  render <AccordionItem>@\n}`);
    const result = typeFormat(uri, pos, '>');
    assert(result && result[0].newText === '</AccordionItem>', `got ${JSON.stringify(result)}`);
});

it('still auto-closes a plain HTML tag (<div>)', () => {
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `export component X {\n  render <div>@\n}`);
    const result = typeFormat(uri, pos, '>');
    assert(result && result[0].newText === '</div>', `got ${JSON.stringify(result)}`);
});

it('still leaves a self-closing tag alone (<br />)', () => {
    const uri = 'file:///t/X.cpx';
    const pos = openWithCursor(uri, `export component X {\n  render <br />@\n}`);
    const result = typeFormat(uri, pos, '>');
    assert(result === null, `expected no edit, got ${JSON.stringify(result)}`);
});

console.log(`\n${'─'.repeat(60)}\n  ${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
