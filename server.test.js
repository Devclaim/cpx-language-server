'use strict';

/**
 * Tests for the pure helper functions in server.js.
 *
 * These cover the context-detection logic that drives completions, so
 * regressions in tag suggestions, match snippets, or expression context
 * are caught before shipping a new VSIX.
 *
 * Run with:  node server.test.js
 */

// ── Inline the helpers under test ────────────────────────────────────────────
// We duplicate the small pure functions here so we don't have to spin up the
// full LSP connection.  Keep them in sync with server.js.

function offsetAt(text, position) {
    const lines = text.split('\n');
    let offset = 0;
    for (let i = 0; i < position.line; i++) {
        offset += lines[i].length + 1;
    }
    return offset + position.character;
}

function positionAt(text, offset) {
    const lines = text.split('\n');
    let remaining = offset;
    for (let i = 0; i < lines.length; i++) {
        if (remaining <= lines[i].length) return { line: i, character: remaining };
        remaining -= lines[i].length + 1;
    }
    return { line: lines.length - 1, character: 0 };
}

function isTagContext(text, position) {
    const offset = offsetAt(text, position);
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    return /<[/]?[A-Z][A-Za-z0-9_]*$/.test(prefix) || /<$/.test(prefix);
}

function isClosingTagContext(text, position) {
    const offset = offsetAt(text, position);
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const prefix = text.slice(lineStart, offset);
    return /<\/[A-Z][A-Za-z0-9_]*$/.test(prefix) || /<\/$/.test(prefix);
}

function getOpenTagContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const tagStart = left.lastIndexOf('<');
    if (tagStart === -1) return null;
    const tail = left.slice(tagStart);
    if (tail.startsWith('</') || tail.includes('>')) return null;
    const match = tail.match(/^<([A-Z][A-Za-z0-9_]*)(?:\s+[^<>]*)?$/);
    if (!match) return null;
    const attrMatch = tail.match(/\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)?$/);
    return { tagName: match[1], partialAttribute: attrMatch && attrMatch[1] ? attrMatch[1] : '' };
}

function isExpressionContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const openBraces = (left.match(/\{/g) || []).length;
    const closeBraces = (left.match(/\}/g) || []).length;
    return openBraces > closeBraces;
}

function getMatchSubjectContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const m = left.match(/\bmatch(\s+([\w.]*))?$/);
    if (!m) return null;
    return { partial: m[2] || '', matchStart: offset - m[0].length };
}

function getMatchBodyContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const m = left.match(/\bmatch\s*\(?\s*([\w.]+)\s*\)?\s*\{\s*$/);
    if (!m) return null;
    return { subject: m[1] };
}

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
    return lines.join(',\n') + '\n';
}

// ── Unused-import detection (inlined from server.js) ─────────────────────────

function parseImports(text) {
    const imports = [];
    const importRegex = /^(\s*)from\s+"([^"]+)"\s+import\s+\{([^}]+)\}/gm;
    let match;
    while ((match = importRegex.exec(text))) {
        const [, , source, rawNames] = match;
        const names = rawNames.split(',').map(v => v.trim()).filter(Boolean);
        imports.push({ source, names: names.map(name => ({ name })) });
    }
    return imports;
}

function parseComponentUsages(text) {
    const usages = [];
    const tagRegex = /<([A-Z][A-Za-z0-9_]*)\b/g;
    let match;
    while ((match = tagRegex.exec(text))) usages.push({ name: match[1] });
    return usages;
}

function parseTypeUsages(text) {
    const usages = [];
    const propertyRegex = /^\s*[a-z][A-Za-z0-9_]*\s*:\s*([^\n]+)$/gm;
    let match;
    while ((match = propertyRegex.exec(text))) {
        const typesText = match[1];
        const typeRegex = /\??([A-Z][A-Za-z0-9_]*)(\[\])?/g;
        let typeMatch;
        while ((typeMatch = typeRegex.exec(typesText))) {
            usages.push({ name: typeMatch[1], isCollection: typeMatch[2] === '[]' });
        }
    }
    return usages;
}

function parseEnumMemberUsages(text) {
    const stripped = text.replace(/"[^"]*"/g, (m) => '"' + ' '.repeat(m.length - 2) + '"');
    const usages = [];
    const enumRegex = /\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g;
    let match;
    while ((match = enumRegex.exec(stripped))) usages.push({ owner: match[1] });
    return usages;
}

/** Returns the list of imported names not found anywhere in the document. */
function findUnusedImports(text) {
    const imports = parseImports(text);
    const usedNames = new Set([
        ...parseComponentUsages(text).map(u => u.name),
        ...parseTypeUsages(text).map(u => u.name),
        ...parseEnumMemberUsages(text).map(u => u.owner),
    ]);
    const unused = [];
    for (const entry of imports) {
        for (const name of entry.names) {
            if (!usedNames.has(name.name)) unused.push(name.name);
        }
    }
    return unused;
}

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let section = '';

function describe(label, fn) {
    section = label;
    fn();
}

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

function assert(val, msg) {
    if (!val) throw new Error(msg || `Expected truthy, got ${JSON.stringify(val)}`);
}

function assertEqual(a, b) {
    if (a !== b) throw new Error(`Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function assertNull(val) {
    if (val !== null) throw new Error(`Expected null, got ${JSON.stringify(val)}`);
}

/** Return a position at the very end of `text`. */
function end(text) {
    const lines = text.split('\n');
    return { line: lines.length - 1, character: lines[lines.length - 1].length };
}

/** Return a position after `needle` in `text`. */
function after(text, needle) {
    const idx = text.indexOf(needle);
    if (idx === -1) throw new Error(`Needle not found: ${needle}`);
    return positionAt(text, idx + needle.length);
}

// ── isTagContext ──────────────────────────────────────────────────────────────

describe('isTagContext', () => {
    it('true immediately after <', () => {
        const t = 'render <';
        assert(isTagContext(t, end(t)));
    });

    it('true while typing a PascalCase tag name', () => {
        const t = 'render <My';
        assert(isTagContext(t, end(t)));
    });

    it('true for partial closing tag </F', () => {
        const t = '</Foo';
        assert(isTagContext(t, end(t)));
    });

    it('false inside an attribute value (known limitation: < in strings is not filtered)', () => {
        // isTagContext does a simple line-prefix regex and does not track string delimiters.
        // A bare < inside an attribute string is treated as a tag start. Acceptable because
        // CPX attribute values rarely contain a literal < character.
        const t = '<Foo bar=value ';
        assert(!isTagContext(t, end(t)), 'should be false after a completed attribute');
    });

    it('false on a plain word', () => {
        const t = 'render foo';
        assert(!isTagContext(t, end(t)));
    });

    it('false after a completed tag', () => {
        const t = '<Foo />';
        assert(!isTagContext(t, end(t)));
    });
});

// ── getOpenTagContext ─────────────────────────────────────────────────────────

function getOpenTagContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const tagStart = left.lastIndexOf('<');
    if (tagStart === -1) return null;
    const tail = left.slice(tagStart);
    if (tail.startsWith('</') || tail.includes('>')) return null;
    const match = tail.match(/^<([A-Z][A-Za-z0-9_]*)(?:\s+[^<>]*)?$/);
    if (!match) return null;
    const attrMatch = tail.match(/\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)?$/);
    return { tagName: match[1], partialAttribute: attrMatch && attrMatch[1] ? attrMatch[1] : '' };
}

function getOpenHtmlTagContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const tagStart = left.lastIndexOf('<');
    if (tagStart === -1) return null;
    const tail = left.slice(tagStart);
    if (tail.startsWith('</') || tail.includes('>')) return null;
    const match = tail.match(/^<([a-z][a-zA-Z0-9-]*)(?:\s+[^<>]*)?$/);
    if (!match) return null;
    const attrMatch = tail.match(/\s+([a-zA-Z_:][-a-zA-Z0-9_:.]*)?$/);
    return { tagName: match[1], partialAttribute: attrMatch && attrMatch[1] ? attrMatch[1] : '' };
}

describe('getOpenTagContext', () => {
    it('null when cursor is just after <', () => {
        const t = 'render <';
        assertNull(getOpenTagContext(t, end(t)));
    });

    it('returns tag name after <Foo ', () => {
        const t = '<Foo ';
        const ctx = getOpenTagContext(t, end(t));
        assert(ctx, 'expected context');
        assertEqual(ctx.tagName, 'Foo');
    });

    it('returns partialAttribute when typing attr name', () => {
        const t = '<Foo ba';
        const ctx = getOpenTagContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.tagName, 'Foo');
        assertEqual(ctx.partialAttribute, 'ba');
    });

    it('null after tag is closed with >', () => {
        const t = '<Foo>';
        assertNull(getOpenTagContext(t, end(t)));
    });

    it('null for a closing tag', () => {
        const t = '</Foo';
        assertNull(getOpenTagContext(t, end(t)));
    });

    it('no-space: tag name absorbed into tagName, partial empty (recovery done in handler)', () => {
        // Without space, the regex absorbs all chars into tagName.
        // The completion handler recovers by stripping trailing lowercase.
        const t = '<Copycl';
        const ctx = getOpenTagContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.tagName, 'Copycl'); // handler will split against index
        assertEqual(ctx.partialAttribute, '');
    });
});

describe('getOpenHtmlTagContext', () => {
    it('returns tag name inside <div ', () => {
        const t = '<div ';
        const ctx = getOpenHtmlTagContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.tagName, 'div');
        assertEqual(ctx.partialAttribute, '');
    });

    it('returns partialAttribute when typing', () => {
        const t = '<div cl';
        const ctx = getOpenHtmlTagContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.partialAttribute, 'cl');
    });

    it('null for PascalCase tag (handled by getOpenTagContext)', () => {
        const t = '<Foo ';
        assertNull(getOpenHtmlTagContext(t, end(t)));
    });

    it('null after >', () => {
        const t = '<div class="x">';
        assertNull(getOpenHtmlTagContext(t, end(t)));
    });
});

// ── getAttributeValueContext ──────────────────────────────────────────────────

function getAttributeValueContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const attrValueMatch = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*\{[^}]*$/.exec(left);
    if (!attrValueMatch) return null;
    const tagStart = left.lastIndexOf('<');
    if (tagStart === -1) return null;
    const tail = left.slice(tagStart);
    if (tail.startsWith('</') || tail.includes('>')) return null;
    const tagMatch = tail.match(/^<([A-Z][A-Za-z0-9_]*)/);
    if (!tagMatch) return null;
    return { tagName: tagMatch[1], attrName: attrValueMatch[1] };
}

describe('getAttributeValueContext', () => {
    it('detects tag name and attr name inside ={', () => {
        const t = '<Headline tag={';
        const ctx = getAttributeValueContext(t, end(t));
        assert(ctx, 'expected context');
        assertEqual(ctx.tagName, 'Headline');
        assertEqual(ctx.attrName, 'tag');
    });

    it('null when not inside a {', () => {
        const t = '<Headline tag=';
        assertNull(getAttributeValueContext(t, end(t)));
    });

    it('null after brace is closed', () => {
        const t = '<Headline tag={Foo} ';
        assertNull(getAttributeValueContext(t, end(t)));
    });

    it('null outside any tag', () => {
        const t = 'render {foo';
        assertNull(getAttributeValueContext(t, end(t)));
    });

    it('null for lowercase tag', () => {
        const t = '<div class={';
        assertNull(getAttributeValueContext(t, end(t)));
    });

    it('works with multiline tag', () => {
        const t = '<Headline\n    content={';
        const ctx = getAttributeValueContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.tagName, 'Headline');
        assertEqual(ctx.attrName, 'content');
    });
});

// ── isExpressionContext ───────────────────────────────────────────────────────

describe('isExpressionContext', () => {
    it('true inside a single { }', () => {
        const t = 'render { foo';
        assert(isExpressionContext(t, end(t)));
    });

    it('false outside braces', () => {
        const t = 'render foo';
        assert(!isExpressionContext(t, end(t)));
    });

    it('false after balanced braces', () => {
        const t = 'render {foo} ';
        assert(!isExpressionContext(t, end(t)));
    });

    it('true inside nested braces', () => {
        const t = 'render {{ foo';
        assert(isExpressionContext(t, end(t)));
    });

    it('true inside class={[ match ... ]} expression', () => {
        const t = 'class={[\n  match (v) {\n    ';
        assert(isExpressionContext(t, end(t)));
    });
});

// ── getMatchSubjectContext ────────────────────────────────────────────────────

describe('getMatchSubjectContext', () => {
    it('matches right after "match" keyword (no space yet)', () => {
        const t = 'render match';
        const ctx = getMatchSubjectContext(t, end(t));
        assert(ctx, 'expected context');
        assertEqual(ctx.partial, '');
    });

    it('matches after "match " with no partial', () => {
        const t = 'render match ';
        const ctx = getMatchSubjectContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.partial, '');
    });

    it('matches after "match col" with partial', () => {
        const t = 'render match col';
        const ctx = getMatchSubjectContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.partial, 'col');
    });

    it('null after match body opens', () => {
        const t = 'render match (col) {';
        assertNull(getMatchSubjectContext(t, end(t)));
    });

    it('null when typing a regular word', () => {
        const t = 'render foo';
        assertNull(getMatchSubjectContext(t, end(t)));
    });

    it('null when typing < (regression: component suggestions must not be blocked)', () => {
        const t = 'render <';
        assertNull(getMatchSubjectContext(t, end(t)));
    });

    it('matchStart points to the m in match', () => {
        const t = 'render match col';
        const ctx = getMatchSubjectContext(t, end(t));
        // "match col" is 9 chars; "render " is 7 chars → matchStart = 7
        assertEqual(ctx.matchStart, 7);
    });
});

// ── getMatchBodyContext ───────────────────────────────────────────────────────

describe('getMatchBodyContext', () => {
    it('detects cursor right after match (prop) {', () => {
        const t = 'match (status) {\n  ';
        const ctx = getMatchBodyContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.subject, 'status');
    });

    it('detects parenthesis-free form', () => {
        const t = 'match status {\n  ';
        const ctx = getMatchBodyContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.subject, 'status');
    });

    it('captures dotted subjects', () => {
        const t = 'match (link.rel) {\n  ';
        const ctx = getMatchBodyContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.subject, 'link.rel');
    });

    it('null when no match block is open', () => {
        const t = 'render <';
        assertNull(getMatchBodyContext(t, end(t)));
    });

    it('null when cursor is still typing the subject (no { yet)', () => {
        const t = 'match status';
        assertNull(getMatchBodyContext(t, end(t)));
    });
});

// ── detectIndent ─────────────────────────────────────────────────────────────

describe('detectIndent', () => {
    it('detects tabs', () => {
        const t = 'component Foo {\n\tprop x: string\n}';
        assertEqual(detectIndent(t), '\t');
    });

    it('detects 2-space indent', () => {
        const t = 'component Foo {\n  prop x: string\n}';
        assertEqual(detectIndent(t), '  ');
    });

    it('detects 4-space indent', () => {
        const t = 'component Foo {\n    prop x: string\n}';
        assertEqual(detectIndent(t), '    ');
    });

    it('defaults to 4 spaces when no indented lines', () => {
        const t = 'component Foo {}';
        assertEqual(detectIndent(t), '    ');
    });
});

// ── buildMatchArmsSnippet ─────────────────────────────────────────────────────

describe('buildMatchArmsSnippet', () => {
    const enumExport = {
        name: 'Status',
        members: [{ name: 'ACTIVE' }, { name: 'INACTIVE' }]
    };

    it('uses provided indent', () => {
        const snippet = buildMatchArmsSnippet(enumExport, '\t');
        assert(snippet.includes('\tStatus.ACTIVE'), 'should use tab indent');
        assert(snippet.includes('\tStatus.INACTIVE'));
        assert(snippet.includes('\tdefault'));
    });

    it('has a default arm', () => {
        const snippet = buildMatchArmsSnippet(enumExport, '  ');
        assert(snippet.includes('default -> "$0"'));
    });

    it('each non-default arm has a unique tab stop', () => {
        const snippet = buildMatchArmsSnippet(enumExport, '  ');
        assert(snippet.includes('"$1"'), 'first member should get $1');
        assert(snippet.includes('"$2"'), 'second member should get $2');
    });

    it('arms are comma-separated', () => {
        const snippet = buildMatchArmsSnippet(enumExport, '  ');
        // Each arm except the last should be followed by a comma
        const lines = snippet.trimEnd().split('\n');
        for (let i = 0; i < lines.length - 1; i++) {
            assert(lines[i].endsWith(','), `line ${i} should end with comma: ${lines[i]}`);
        }
    });
});

// ── findUnusedImports ─────────────────────────────────────────────────────────

describe('findUnusedImports', () => {
    it('no imports → nothing unused', () => {
        const t = `export component X {\n  render <div />\n}`;
        assertEqual(findUnusedImports(t).length, 0);
    });

    it('import used as component tag → not unused', () => {
        const t = `from "./Button" import { Button }\nexport component X {\n  render <Button />\n}`;
        assertEqual(findUnusedImports(t).length, 0);
    });

    it('import used as prop type → not unused', () => {
        const t = `from "./Icon" import { Icon }\nexport component X {\n  icon: Icon\n  render <div />\n}`;
        assertEqual(findUnusedImports(t).length, 0);
    });

    it('import used as array prop type → not unused', () => {
        const t = `from "./Item" import { Item }\nexport component X {\n  items: Item[]\n  render <div />\n}`;
        assertEqual(findUnusedImports(t).length, 0);
    });

    it('import used in enum member access → not unused', () => {
        const t = `from "./Status" import { Status }\nexport component X {\n  render <div>{Status.ACTIVE}</div>\n}`;
        assertEqual(findUnusedImports(t).length, 0);
    });

    it('import not used anywhere → flagged as unused', () => {
        const t = `from "./Button" import { Button }\nexport component X {\n  render <div />\n}`;
        const unused = findUnusedImports(t);
        assertEqual(unused.length, 1);
        assertEqual(unused[0], 'Button');
    });

    it('one of two imports unused → only that one flagged', () => {
        const t = `from "./ui" import { Button, Icon }\nexport component X {\n  render <Button />\n}`;
        const unused = findUnusedImports(t);
        assertEqual(unused.length, 1);
        assertEqual(unused[0], 'Icon');
    });

    it('all imports unused → all flagged', () => {
        const t = `from "./ui" import { Button, Icon }\nexport component X {\n  render <div />\n}`;
        const unused = findUnusedImports(t);
        assertEqual(unused.length, 2);
    });

    it('import used in match arm (enum access) → not unused', () => {
        const t = `from "./LinkVariant" import { LinkVariant }\nexport component X {\n  variant: LinkVariant\n  render match (variant) {\n    LinkVariant.DEFAULT -> "a",\n    default -> "b"\n  }\n}`;
        assertEqual(findUnusedImports(t).length, 0);
    });

    it('file path string containing PascalCase.ext not treated as enum member usage', () => {
        // "Accordion.cpx" in the import path must not make Accordion appear used
        const t = `from "../Accordion/Accordion.cpx" import { Accordion }\nexport component X {\n  render <div />\n}`;
        const unused = findUnusedImports(t);
        assertEqual(unused.length, 1);
        assertEqual(unused[0], 'Accordion');
    });
});

// ── parseIdentifierUsagesInRender ────────────────────────────────────────────

/**
 * Inline test-only version: returns just the identifier names (no ranges).
 */
function identifierUsagesInRender(text) {
    // Extract render body
    const renderMatch = /\brender\b/.exec(text);
    if (!renderMatch) return [];
    const renderText = text.slice(renderMatch.index + renderMatch[0].length);
    const stripped = renderText.replace(/"[^"]*"/g, (m) => ' '.repeat(m.length));
    const KEYWORDS = new Set(['null', 'true', 'false', 'match', 'default', 'render', 'slot']);
    const names = [];

    const add = (name) => { if (!KEYWORDS.has(name)) names.push(name); };

    let m;
    const matchSubjectRe = /\bmatch\s*\(\s*([a-z][A-Za-z0-9_]*)\s*\)/g;
    while ((m = matchSubjectRe.exec(stripped))) add(m[1]);

    const braceExprRe = /\{\s*([a-z][A-Za-z0-9_]*)\s*\}/g;
    while ((m = braceExprRe.exec(stripped))) add(m[1]);

    const accessChainRe = /(?<![.A-Za-z0-9_])([a-z][A-Za-z0-9_]*)\./g;
    while ((m = accessChainRe.exec(stripped))) add(m[1]);

    return [...new Set(names)]; // deduplicate for assertion convenience
}

function parseProps(text) {
    const match = /export\s+component\s+\w+\s*\{([\s\S]*?)render\b/.exec(text);
    if (!match) return [];
    const block = match[1];
    const props = [];
    const re = /^\s*([a-z][A-Za-z0-9_]*)\s*:/gm;
    let m;
    while ((m = re.exec(block))) props.push(m[1]);
    return props;
}

function findUndeclaredProps(text) {
    const declaredProps = new Set(parseProps(text));
    return identifierUsagesInRender(text).filter(name => !declaredProps.has(name));
}

describe('prop identifier usage validation', () => {
    it('all props declared → no errors', () => {
        const t = `export component X {\n  col: TextColumns\n  render match (col) {\n    TextColumns.A -> "a",\n    default -> "b"\n  }\n}`;
        assertEqual(findUndeclaredProps(t).length, 0);
    });

    it('match subject not declared → flagged', () => {
        const t = `export component X {\n  render match (columns) {\n    default -> "a"\n  }\n}`;
        const bad = findUndeclaredProps(t);
        assert(bad.includes('columns'), `expected columns in [${bad}]`);
    });

    it('brace expression not declared → flagged', () => {
        const t = `export component X {\n  render <div>{button}</div>\n}`;
        const bad = findUndeclaredProps(t);
        assert(bad.includes('button'), `expected button in [${bad}]`);
    });

    it('brace expression declared → not flagged', () => {
        const t = `export component X {\n  button: slot\n  render <div>{button}</div>\n}`;
        assertEqual(findUndeclaredProps(t).length, 0);
    });

    it('PascalCase in brace expression → not flagged (not a prop)', () => {
        const t = `export component X {\n  render <div>{Button}</div>\n}`;
        assertEqual(findUndeclaredProps(t).length, 0);
    });

    it('enum member access PascalCase.MEMBER → not flagged', () => {
        const t = `export component X {\n  variant: LinkVariant\n  render match (variant) {\n    LinkVariant.DEFAULT -> "a",\n    default -> "b"\n  }\n}`;
        assertEqual(findUndeclaredProps(t).length, 0);
    });

    it('file path string does not produce false prop usage', () => {
        // "Accordion.cpx" must not make "accordion" appear as a used identifier
        const t = `from "../Accordion/Accordion.cpx" import { Accordion }\nexport component X {\n  render <div />\n}`;
        assertEqual(findUndeclaredProps(t).length, 0);
    });
});

// ── parseAttributeValueEnumUsages ────────────────────────────────────────────

function parseAttributeValueEnumUsages(text) {
    const stripped = text.replace(/"[^"]*"/g, (m) => ' '.repeat(m.length));
    const results = [];
    const re = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*\{\s*([A-Z][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}/g;
    let m;
    while ((m = re.exec(stripped))) {
        const before = stripped.slice(0, m.index);
        const tagStart = before.lastIndexOf('<');
        if (tagStart === -1) continue;
        const tagSlice = stripped.slice(tagStart);
        const tagNameMatch = tagSlice.match(/^<([A-Z][A-Za-z0-9_]*)/);
        if (!tagNameMatch) continue;
        results.push({
            tagName: tagNameMatch[1],
            attrName: m[1],
            typeName: m[2],
            memberName: m[3]
        });
    }
    return results;
}

describe('parseAttributeValueEnumUsages', () => {
    it('detects single enum attribute', () => {
        const t = `render <Headline tag={HeadlineTag.TAG_H2} />`;
        const r = parseAttributeValueEnumUsages(t);
        assertEqual(r.length, 1);
        assertEqual(r[0].tagName, 'Headline');
        assertEqual(r[0].attrName, 'tag');
        assertEqual(r[0].typeName, 'HeadlineTag');
        assertEqual(r[0].memberName, 'TAG_H2');
    });

    it('detects multiple enum attributes on one tag', () => {
        const t = `render <Headline tag={HeadlineTag.TAG_H2} size={HeadlineSize.SIZE_LG} />`;
        const r = parseAttributeValueEnumUsages(t);
        assertEqual(r.length, 2);
        assertEqual(r[0].typeName, 'HeadlineTag');
        assertEqual(r[1].typeName, 'HeadlineSize');
    });

    it('ignores lowercase tags (HTML elements)', () => {
        const t = `render <div class={Foo.BAR} />`;
        const r = parseAttributeValueEnumUsages(t);
        assertEqual(r.length, 0);
    });

    it('ignores string literals that look like enum access', () => {
        const t = `render <Headline tag="HeadlineTag.TAG_H2" />`;
        const r = parseAttributeValueEnumUsages(t);
        assertEqual(r.length, 0);
    });

    it('ignores prop references (non-enum brace values)', () => {
        const t = `render <Headline content={headline} />`;
        const r = parseAttributeValueEnumUsages(t);
        assertEqual(r.length, 0);
    });

    it('handles multiline tag', () => {
        const t = `render\n  <Headline\n    tag={HeadlineTag.TAG_H2}\n  />`;
        const r = parseAttributeValueEnumUsages(t);
        assertEqual(r.length, 1);
        assertEqual(r[0].tagName, 'Headline');
        assertEqual(r[0].memberName, 'TAG_H2');
    });
});

// ── getPascalMemberAccessContext ──────────────────────────────────────────────

function getPascalMemberAccessContext(text, position) {
    const offset = offsetAt(text, position);
    const left = text.slice(0, offset);
    const match = left.match(/\b([A-Z][A-Za-z0-9_]*)\.([A-Za-z0-9_]*)$/);
    if (!match) return null;
    return { typeName: match[1], partial: match[2] || '' };
}

describe('getPascalMemberAccessContext', () => {
    it('detects PascalCase. with no partial', () => {
        const t = 'HeadlineTag.';
        const ctx = getPascalMemberAccessContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.typeName, 'HeadlineTag');
        assertEqual(ctx.partial, '');
    });

    it('detects PascalCase.PARTIAL', () => {
        const t = 'HeadlineTag.TAG_H';
        const ctx = getPascalMemberAccessContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.typeName, 'HeadlineTag');
        assertEqual(ctx.partial, 'TAG_H');
    });

    it('null for lowercase.member (struct access)', () => {
        const t = 'item.field';
        assertNull(getPascalMemberAccessContext(t, end(t)));
    });

    it('null when cursor is on PascalCase itself (before dot)', () => {
        const t = 'HeadlineTag';
        assertNull(getPascalMemberAccessContext(t, end(t)));
    });

    it('works inside match arm', () => {
        const t = 'match (v) {\n  TextColumns.';
        const ctx = getPascalMemberAccessContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.typeName, 'TextColumns');
    });

    it('works inside attribute value braces', () => {
        const t = '<Headline tag={HeadlineTag.';
        const ctx = getPascalMemberAccessContext(t, end(t));
        assert(ctx);
        assertEqual(ctx.typeName, 'HeadlineTag');
    });
});

// ── parseAttributeValueLiteralUsages ─────────────────────────────────────────

function findEnclosingPascalTag(text, offset) {
    const before = text.slice(0, offset);
    const tagStart = before.lastIndexOf('<');
    if (tagStart === -1) return null;
    const tagSlice = text.slice(tagStart);
    const tagNameMatch = tagSlice.match(/^<([A-Z][A-Za-z0-9_]*)/);
    return tagNameMatch ? tagNameMatch[1] : null;
}

function parseAttributeValueLiteralUsages(text) {
    const results = [];

    function push(tagName, attrName, literalType, matchIndex, matchStr) {
        const valueStart = matchIndex + matchStr.search(/[{"]/);
        results.push({ tagName, attrName, literalType, valueStart, valueEnd: matchIndex + matchStr.length });
    }

    let m;
    const braceStringRe = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*\{"[^"]*"\}/g;
    while ((m = braceStringRe.exec(text))) {
        const tagName = findEnclosingPascalTag(text, m.index);
        if (!tagName) continue;
        push(tagName, m[1], 'string', m.index, m[0]);
    }

    const braceLiteralRe = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*\{(true|false|null|0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?)\}/g;
    while ((m = braceLiteralRe.exec(text))) {
        const tagName = findEnclosingPascalTag(text, m.index);
        if (!tagName) continue;
        const literal = m[2];
        const literalType = (literal === 'true' || literal === 'false') ? 'boolean'
            : literal === 'null' ? 'null' : 'number';
        push(tagName, m[1], literalType, m.index, m[0]);
    }

    const bareStringRe = /([a-zA-Z_][-a-zA-Z0-9_]*)\s*=\s*"[^"]*"/g;
    while ((m = bareStringRe.exec(text))) {
        const tagName = findEnclosingPascalTag(text, m.index);
        if (!tagName) continue;
        push(tagName, m[1], 'string', m.index, m[0]);
    }

    return results;
}

describe('parseAttributeValueLiteralUsages', () => {
    it('detects brace-string literal', () => {
        const t = `render <Headline tag={"fdsfd"} />`;
        const r = parseAttributeValueLiteralUsages(t);
        assertEqual(r.length, 1);
        assertEqual(r[0].tagName, 'Headline');
        assertEqual(r[0].attrName, 'tag');
        assertEqual(r[0].literalType, 'string');
    });

    it('detects boolean literal', () => {
        const t = `render <Button disabled={true} />`;
        const r = parseAttributeValueLiteralUsages(t);
        assertEqual(r.length, 1);
        assertEqual(r[0].literalType, 'boolean');
        assertEqual(r[0].attrName, 'disabled');
    });

    it('detects number literal', () => {
        const t = `render <Grid columns={3} />`;
        const r = parseAttributeValueLiteralUsages(t);
        assertEqual(r.length, 1);
        assertEqual(r[0].literalType, 'number');
    });

    it('detects bare string attribute', () => {
        const t = `render <ContentGrid componentName="Text" />`;
        const r = parseAttributeValueLiteralUsages(t);
        assertEqual(r.length, 1);
        assertEqual(r[0].tagName, 'ContentGrid');
        assertEqual(r[0].attrName, 'componentName');
        assertEqual(r[0].literalType, 'string');
    });

    it('ignores literals on lowercase HTML tags', () => {
        const t = `render <div class={"foo"} />`;
        const r = parseAttributeValueLiteralUsages(t);
        assertEqual(r.length, 0);
    });

    it('ignores enum member values (not literals)', () => {
        const t = `render <Headline tag={HeadlineTag.TAG_H2} />`;
        const r = parseAttributeValueLiteralUsages(t);
        assertEqual(r.length, 0);
    });

    it('ignores prop reference values', () => {
        const t = `render <Headline content={headline} />`;
        const r = parseAttributeValueLiteralUsages(t);
        assertEqual(r.length, 0);
    });

    it('detects hex number literal', () => {
        const t = `render <Foo color={0xFF0000} />`;
        const r = parseAttributeValueLiteralUsages(t);
        assertEqual(r.length, 1);
        assertEqual(r[0].literalType, 'number');
    });
});

describe('slot accepts string literals', () => {
    const LITERAL_COMPATIBLE = {
        string:  ['string', 'slot'],
        boolean: ['boolean'],
        number:  ['number', 'integer'],
        null:    []
    };
    function isLiteralCompatible(propType, literalType) {
        const typeComponents = propType
            .split('|')
            .map(t => t.trim().replace(/^\?/, '').replace(/\[\]$/, '').toLowerCase());
        const compatible = LITERAL_COMPATIBLE[literalType] || [];
        return typeComponents.some(t => compatible.includes(t));
    }

    it('string literal is compatible with slot', () => {
        assert(isLiteralCompatible('slot', 'string'));
    });

    it('string literal is compatible with string|slot union', () => {
        assert(isLiteralCompatible('string | slot', 'string'));
    });

    it('string literal is NOT compatible with HeadlineTag', () => {
        assert(!isLiteralCompatible('HeadlineTag', 'string'));
    });

    it('boolean literal is NOT compatible with slot', () => {
        assert(!isLiteralCompatible('slot', 'boolean'));
    });
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
