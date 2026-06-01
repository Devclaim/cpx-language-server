'use strict';

/**
 * CPX recursive-descent parser, mirroring grammar.php.
 * Returns LSP-compatible diagnostics (0-indexed line/col).
 */

class ParseError extends Error {
    /**
     * @param {string} message
     * @param {number} line
     * @param {number} col
     */
    constructor(message, line, col) {
        super(message);
        this.startLine = line;
        this.startCol = col;
        this.endLine = line;
        this.endCol = col + 1;
    }
}

class CPXParser {
    /** @param {string} source */
    constructor(source) {
        this.src = source;
        this.pos = 0;
        this.line = 0;
        this.col = 0;
        /** @type {Array<{startLine:number,startCol:number,endLine:number,endCol:number}>|null} */
        this.textRanges = null;
    }

    // ── State ────────────────────────────────────────────────────────────────

    save() { return { pos: this.pos, line: this.line, col: this.col }; }
    restore(s) { this.pos = s.pos; this.line = s.line; this.col = s.col; }

    isEOF() { return this.pos >= this.src.length; }
    peek(n = 0) { return this.src[this.pos + n]; }

    advance() {
        if (this.isEOF()) return;
        if (this.src[this.pos] === '\n') { this.line++; this.col = 0; }
        else { this.col++; }
        this.pos++;
    }

    fail(msg) {
        throw new ParseError(msg, this.line, this.col);
    }

    // ── Primitives ────────────────────────────────────────────────────────────

    tryLiteral(s) {
        if (this.src.startsWith(s, this.pos)) {
            for (let i = 0; i < s.length; i++) this.advance();
            return true;
        }
        return false;
    }

    requireLiteral(s) {
        if (!this.tryLiteral(s)) this.fail(`Expected "${s}"`);
    }

    // ── Whitespace / Comments ─────────────────────────────────────────────────

    /** optional space (whitespace + comments) */
    osp() {
        while (!this.isEOF()) {
            const c = this.src[this.pos];
            if (c === ' ' || c === '\n' || c === '\t' || c === '\r') {
                this.advance();
            } else if (c === '/') {
                const c2 = this.src[this.pos + 1];
                if (c2 === '/' || c2 === '*') { this.parseComment(); }
                else break;
            } else break;
        }
    }

    /** mandatory space */
    msp() {
        const start = this.pos;
        this.osp();
        if (this.pos === start) this.fail('Expected whitespace');
    }

    parseComment() {
        this.advance(); // /
        if (this.peek() === '/') {
            this.advance();
            while (!this.isEOF() && this.peek() !== '\n') this.advance();
        } else {
            // block comment
            this.advance(); // *
            while (!this.isEOF()) {
                if (this.peek() === '*' && this.peek(1) === '/') {
                    this.advance(); this.advance(); return;
                }
                this.advance();
            }
            this.fail('Unterminated block comment');
        }
    }

    // ── Identifiers & Keywords ────────────────────────────────────────────────

    tryIdentifier() {
        const c = this.peek();
        if (!c || !/[a-zA-Z_]/.test(c)) return null;
        let id = '';
        while (!this.isEOF() && /[a-zA-Z0-9_]/.test(this.peek())) {
            id += this.peek(); this.advance();
        }
        return id;
    }

    requireIdentifier() {
        const id = this.tryIdentifier();
        if (!id) this.fail('Expected identifier');
        return id;
    }

    tryKeyword(kw) {
        if (!this.src.startsWith(kw, this.pos)) return false;
        const after = this.src[this.pos + kw.length];
        if (after && /[a-zA-Z0-9_]/.test(after)) return false;
        for (let i = 0; i < kw.length; i++) this.advance();
        return true;
    }

    requireKeyword(kw) {
        if (!this.tryKeyword(kw)) this.fail(`Expected keyword "${kw}"`);
    }

    // ── Strings ───────────────────────────────────────────────────────────────

    /** StringConstant – no interpolation */
    parseStringConstant() {
        this.requireLiteral('"');
        while (!this.isEOF() && this.peek() !== '"') {
            if (this.peek() === '\\') { this.advance(); if (!this.isEOF()) this.advance(); }
            else this.advance();
        }
        this.requireLiteral('"');
    }

    /** StringLiteral – with {Expression} interpolation */
    parseStringLiteral() {
        this.requireLiteral('"');
        while (!this.isEOF() && this.peek() !== '"') {
            if (this.peek() === '{') {
                this.advance(); this.osp();
                if (this.peek() !== '}') this.parseExpression(0);
                this.osp(); this.requireLiteral('}');
            } else if (this.peek() === '\\') {
                this.advance(); if (!this.isEOF()) this.advance();
            } else {
                this.advance();
            }
        }
        this.requireLiteral('"');
    }

    // ── Integer Literals ──────────────────────────────────────────────────────

    parseIntegerLiteral() {
        const c = this.peek();
        if (c === '0') {
            const c2 = this.peek(1);
            if (c2 === 'b' || c2 === 'B') {
                this.advance(); this.advance();
                if (!/[01]/.test(this.peek())) this.fail('Expected binary digits after 0b');
                while (!this.isEOF() && /[01]/.test(this.peek())) this.advance();
                return;
            }
            if (c2 === 'o') {
                this.advance(); this.advance();
                if (!/[0-7]/.test(this.peek())) this.fail('Expected octal digits after 0o');
                while (!this.isEOF() && /[0-7]/.test(this.peek())) this.advance();
                return;
            }
            if (c2 === 'x' || c2 === 'X') {
                this.advance(); this.advance();
                if (!/[0-9a-fA-F]/.test(this.peek())) this.fail('Expected hex digits after 0x');
                while (!this.isEOF() && /[0-9a-fA-F]/.test(this.peek())) this.advance();
                return;
            }
        }
        if (!/[0-9]/.test(c)) this.fail('Expected integer literal');
        while (!this.isEOF() && /[0-9]/.test(this.peek())) this.advance();
    }

    // ── Array Literal ─────────────────────────────────────────────────────────

    parseArrayLiteral() {
        this.requireLiteral('['); this.osp();
        while (!this.isEOF() && this.peek() !== ']') {
            this.parseExpression(0); this.osp();
            if (!this.tryLiteral(',')) break;
            this.osp();
        }
        this.requireLiteral(']');
    }

    // ── XML Names ─────────────────────────────────────────────────────────────

    tryXmlName() {
        const c = this.peek();
        if (!c || !/[:A-Z_a-z]/.test(c)) return null;
        let name = '';
        while (!this.isEOF() && /[:A-Z_a-z\-.0-9·]/.test(this.peek())) {
            name += this.peek(); this.advance();
        }
        return name;
    }

    requireXmlName() {
        const name = this.tryXmlName();
        if (!name) this.fail('Expected XML name');
        return name;
    }

    // ── Tag / Fragment ────────────────────────────────────────────────────────

    /**
     * Called right after '<' has been consumed.
     * Handles both tag and fragment.
     */
    parseTagOrFragmentBody() {
        if (this.peek() === '>') {
            // Fragment: <> children </>
            this.advance();
            this.parseChildren();
            this.requireLiteral('</>');
        } else {
            // Tag
            const tagName = this.requireXmlName();
            this.parseAttributes();
            if (this.tryLiteral('/>')) return;
            this.requireLiteral('>');
            this.parseChildren();
            this.requireLiteral('</');
            const closingName = this.requireXmlName();
            if (closingName !== tagName) {
                this.fail(`Mismatched closing tag: expected </${tagName}>, got </${closingName}>`);
            }
            this.requireLiteral('>');
        }
    }

    parseAttributes() {
        while (!this.isEOF()) {
            const c = this.peek();
            if (c === '/' || c === '>') break;
            // Mandatory space before each attribute
            if (c !== ' ' && c !== '\n' && c !== '\t' && c !== '\r') break;
            this.osp();
            if (this.peek() === '/' || this.peek() === '>') break;
            if (this.peek() === '{') {
                // empty spread placeholder: { }
                this.advance(); this.osp(); this.requireLiteral('}');
                continue;
            }
            if (!this.tryXmlName()) break; // no attribute name → stop
            if (this.tryLiteral('=')) {
                if (this.peek() === '"') {
                    this.parseStringLiteral();
                } else if (this.tryLiteral('{')) {
                    this.osp(); this.parseExpression(0); this.osp(); this.requireLiteral('}');
                } else {
                    this.fail('Expected attribute value (string or {expression})');
                }
            }
        }
    }

    parseChildren() {
        while (!this.isEOF()) {
            if (this.src.startsWith('</', this.pos)) break; // closing tag handled by caller

            const c = this.peek();
            if (c === '{') {
                this.advance(); this.osp();
                if (this.peek() !== '}') this.parseExpression(0);
                this.osp(); this.requireLiteral('}');
            } else if (c === '<') {
                this.advance();
                this.parseTagOrFragmentBody();
            } else if (c === '&') {
                this.parseXmlCharRef();
            } else {
                // Text content — collect contiguous run into a single range
                const startLine = this.line, startCol = this.col;
                while (!this.isEOF() &&
                       !this.src.startsWith('</', this.pos) &&
                       this.peek() !== '{' &&
                       this.peek() !== '<' &&
                       this.peek() !== '&') {
                    this.advance();
                }
                if (this.textRanges) {
                    this.textRanges.push({
                        startLine,
                        startCol,
                        endLine: this.line,
                        endCol: this.col
                    });
                }
            }
        }
    }

    parseXmlCharRef() {
        this.requireLiteral('&');
        if (this.peek() === '#') {
            this.advance();
            if (this.peek() === 'x') {
                this.advance();
                while (!this.isEOF() && /[0-9a-fA-F]/.test(this.peek())) this.advance();
            } else {
                while (!this.isEOF() && /[0-9]/.test(this.peek())) this.advance();
            }
        } else {
            while (!this.isEOF() && /[a-zA-Z]/.test(this.peek())) this.advance();
        }
        this.requireLiteral(';');
    }

    // ── Match ─────────────────────────────────────────────────────────────────

    parseMatch() {
        // 'match' already consumed
        this.osp();
        // Parse subject expression – stops naturally before '{' since '{' is not
        // a valid infix operator and not a valid primary expression.
        this.parseExpression(0);
        this.requireLiteral('{');
        this.osp();
        this.parseMatchArm();
        this.osp();
        while (this.tryLiteral(',')) {
            this.osp();
            if (this.peek() === '}') break; // trailing comma
            this.parseMatchArm();
            this.osp();
        }
        this.requireLiteral('}');
    }

    parseMatchArm() {
        if (this.tryKeyword('default')) {
            this.osp();
        } else {
            // One or more comma-separated expressions as the left side
            this.parseExpression(0); this.osp();
            // Additional left-side values (before '->') – only consume commas
            // that are NOT followed by '->'
            while (this.peek() === ',') {
                const s = this.save();
                this.advance(); this.osp(); // consume ','
                if (this.src.startsWith('->', this.pos)) { this.restore(s); break; }
                this.parseExpression(0); this.osp();
            }
        }
        this.requireLiteral('->');
        this.osp();
        this.parseExpression(0);
    }

    // ── Expression (Pratt/precedence-climbing) ────────────────────────────────

    /**
     * Operators and their precedences (from grammar.php):
     *  1  right  ternary    ? :
     *  2  right  ??
     *  3  left   ||
     *  4  left   &&
     *  5  left   === !==
     *  6  left   < > >= <=
     *  7  prefix !
     *  8  left   access  .  ?.
     */

    /** @returns {{ type: string, op: string, prec: number, assoc: string, len: number } | null} */
    peekInfixOp() {
        const s = this.src, p = this.pos;
        if (s.startsWith('===', p)) return { type: 'binary', op: '===', prec: 5, assoc: 'left', len: 3 };
        if (s.startsWith('!==', p)) return { type: 'binary', op: '!==', prec: 5, assoc: 'left', len: 3 };
        if (s.startsWith('>=', p))  return { type: 'binary', op: '>=',  prec: 6, assoc: 'left', len: 2 };
        if (s.startsWith('<=', p))  return { type: 'binary', op: '<=',  prec: 6, assoc: 'left', len: 2 };
        if (s.startsWith('&&', p))  return { type: 'binary', op: '&&',  prec: 4, assoc: 'left', len: 2 };
        if (s.startsWith('||', p))  return { type: 'binary', op: '||',  prec: 3, assoc: 'left', len: 2 };
        if (s.startsWith('??', p))  return { type: 'binary', op: '??',  prec: 2, assoc: 'right', len: 2 };
        if (s.startsWith('?.', p))  return { type: 'access', op: '?.', prec: 8, assoc: 'left', len: 2 };
        const c = s[p];
        // '<' is infix only when NOT starting a tag (after a value, it's always comparison)
        if (c === '<') return { type: 'binary', op: '<', prec: 6, assoc: 'left', len: 1 };
        if (c === '>') return { type: 'binary', op: '>', prec: 6, assoc: 'left', len: 1 };
        if (c === '.') return { type: 'access', op: '.', prec: 8, assoc: 'left', len: 1 };
        if (c === '?') return { type: 'ternary', op: '?', prec: 1, assoc: 'right', len: 1 };
        return null;
    }

    /**
     * Parse an expression using precedence climbing.
     * Returns the "value type" of the top-level expression so callers can apply
     * semantic constraints (e.g. logical operands must not be literals).
     *
     * Types: 'string' | 'integer' | 'array' | 'tag' | 'other'
     *
     * @param {number} minPrec
     * @returns {string}
     */
    parseExpression(minPrec) {
        const leftLine = this.line, leftCol = this.col;
        let leftType = this.parsePrimary();

        while (true) {
            this.osp();
            const op = this.peekInfixOp();
            if (!op || op.prec < minPrec) break;

            const isLogical = op.op === '&&' || op.op === '||';

            // Validate left operand of logical operators
            // Only string literals are disallowed (integers/bools are fine per Numbers.cpx)
            if (isLogical && leftType === 'string') {
                throw new ParseError(
                    `String literal is not allowed inside a logic operation`,
                    leftLine, leftCol
                );
            }

            for (let i = 0; i < op.len; i++) this.advance(); // consume operator
            this.osp();

            if (op.type === 'access') {
                this.requireIdentifier();
                leftType = 'other';
            } else if (op.type === 'ternary') {
                this.parseExpression(0);
                this.osp();
                this.requireLiteral(':');
                this.osp();
                this.parseExpression(1);
                leftType = 'other';
            } else {
                const nextPrec = op.assoc === 'right' ? op.prec : op.prec + 1;
                const rightLine = this.line, rightCol = this.col;
                const rightType = this.parseExpression(nextPrec);

                // Validate right operand of logical operators
                if (isLogical && rightType === 'string') {
                    throw new ParseError(
                        `String literal is not allowed inside a logic operation`,
                        rightLine, rightCol
                    );
                }
                leftType = 'other';
            }
        }
        return leftType;
    }

    /**
     * Parse a primary (prefix) expression.
     * Returns: 'string' | 'integer' | 'array' | 'tag' | 'other'
     * @returns {string}
     */
    parsePrimary() {
        this.osp();
        if (this.isEOF()) this.fail('Unexpected end of input, expected expression');

        const c = this.peek();

        if (c === '(') {
            this.advance(); this.osp();
            this.parseExpression(0);
            this.osp(); this.requireLiteral(')');
            return 'other';
        }

        if (c === '!') {
            this.advance(); this.osp();
            this.parseExpression(7);
            return 'other';
        }

        if (c === '"') { this.parseStringLiteral(); return 'string'; }
        if (c === '[') { this.parseArrayLiteral(); return 'array'; }

        if (c === '<') {
            // In primary position '<' always starts a tag or fragment
            this.advance();
            this.parseTagOrFragmentBody();
            return 'tag';
        }

        if (/[0-9]/.test(c)) { this.parseIntegerLiteral(); return 'integer'; }

        if (/[a-zA-Z_]/.test(c)) {
            if (this.tryKeyword('null'))  return 'other';
            if (this.tryKeyword('true'))  return 'other';
            if (this.tryKeyword('false')) return 'other';
            if (this.tryKeyword('match')) { this.parseMatch(); return 'other'; }
            this.requireIdentifier();
            return 'other';
        }

        this.fail(`Unexpected character "${c}"`);
    }

    // ── Type Reference ────────────────────────────────────────────────────────

    parseTypeReference() {
        if (this.tryLiteral('?')) {
            this.requireIdentifier();
            return;
        }
        this.requireIdentifier();
        if (this.tryLiteral('[]')) return; // array type  e.g. string[]
        // Union type: Identifier (| Identifier)*  – spaces around | are tolerated
        while (true) {
            const s = this.save();
            this.osp();
            if (!this.tryLiteral('|')) { this.restore(s); break; }
            this.osp();
            if (!this.tryIdentifier()) { this.restore(s); break; }
        }
    }

    // ── Symbol Declarations ───────────────────────────────────────────────────

    parseSymbolDeclarations() {
        while (!this.isEOF()) {
            const s = this.save();
            const id = this.tryIdentifier();
            if (!id) { this.restore(s); break; }
            if (id === 'render') { this.restore(s); break; }
            // If next is not ':' this isn't a symbol declaration; could be render keyword
            if (this.peek() !== ':') { this.restore(s); break; }
            this.advance(); // ':'
            // Mandatory space after ':'
            if (this.peek() !== ' ' && this.peek() !== '\t' && this.peek() !== '\n') {
                this.restore(s); break;
            }
            this.msp();
            this.parseTypeReference();
            this.osp();
        }
    }

    // ── Enum ──────────────────────────────────────────────────────────────────

    parseEnumMemberDeclarations() {
        // At least one member required
        this.parseEnumMemberDeclaration();
        this.osp();
        while (!this.isEOF() && this.peek() !== '}') {
            this.parseEnumMemberDeclaration();
            this.osp();
        }
    }

    parseEnumMemberDeclaration() {
        this.requireIdentifier();
        this.osp();
        if (this.tryLiteral('(')) {
            this.osp();
            if (this.peek() === '"') { this.parseStringConstant(); }
            else { this.parseIntegerLiteral(); }
            this.osp();
            this.requireLiteral(')');
        }
    }

    // ── Import ────────────────────────────────────────────────────────────────

    parseImport() {
        this.requireKeyword('from');
        this.osp();
        this.parseStringConstant();
        this.osp();
        this.requireKeyword('import');
        this.osp();
        this.requireLiteral('{');
        this.osp();
        this.parseImportName();
        this.osp();
        while (this.tryLiteral(',')) {
            this.osp();
            if (this.peek() === '}') break;
            this.parseImportName();
            this.osp();
        }
        this.requireLiteral('}');
        this.osp();
    }

    parseImportName() {
        this.requireIdentifier();
        this.osp();
        if (this.tryKeyword('as')) { this.osp(); this.requireIdentifier(); }
    }

    // ── Declarations ─────────────────────────────────────────────────────────

    parseComponentDeclaration() {
        this.msp();
        this.requireIdentifier(); // name
        this.msp();
        this.requireLiteral('{');
        this.osp();
        this.parseSymbolDeclarations();
        this.requireKeyword('render');
        this.msp();
        this.parseExpression(0);
        this.osp();
        this.requireLiteral('}');
    }

    parseEnumDeclaration() {
        this.msp();
        this.requireIdentifier(); // name
        this.msp();
        this.requireLiteral('{');
        this.osp();
        this.parseEnumMemberDeclarations();
        this.requireLiteral('}');
    }

    parseStructDeclaration() {
        this.msp();
        this.requireIdentifier(); // name
        this.msp();
        this.requireLiteral('{');
        this.osp();
        this.parseSymbolDeclarations();
        this.requireLiteral('}');
    }

    // ── Module (top-level entry point) ────────────────────────────────────────

    parseModule() {
        this.osp();
        // Zero or more imports
        while (!this.isEOF()) {
            const s = this.save();
            if (!this.src.startsWith('from', this.pos)) break;
            // Ensure 'from' is a keyword (not an identifier starting with 'from...')
            const after = this.src[this.pos + 4];
            if (after && /[a-zA-Z0-9_]/.test(after)) break;
            this.parseImport();
        }
        // Single export
        this.requireKeyword('export');
        this.msp();
        if (this.tryKeyword('component')) {
            this.parseComponentDeclaration();
        } else if (this.tryKeyword('enum')) {
            this.parseEnumDeclaration();
        } else if (this.tryKeyword('struct')) {
            this.parseStructDeclaration();
        } else {
            this.fail('Expected "component", "enum", or "struct" after "export"');
        }
        this.osp();
        if (!this.isEOF()) this.fail('Unexpected content after declaration');
    }
}

/**
 * Parse CPX source and return LSP-compatible diagnostics.
 * @param {string} source
 * @returns {{ message: string, startLine: number, startCol: number, endLine: number, endCol: number }[]}
 */
function parseCPX(source) {
    const parser = new CPXParser(source);
    try {
        parser.parseModule();
        return [];
    } catch (e) {
        if (e instanceof ParseError) {
            return [{
                message: e.message,
                startLine: e.startLine,
                startCol:  e.startCol,
                endLine:   e.endLine,
                endCol:    e.endCol,
            }];
        }
        return [{ message: String(e), startLine: 0, startCol: 0, endLine: 0, endCol: 1 }];
    }
}

/**
 * Parse CPX source and return both diagnostics and text-content ranges.
 * Text ranges identify positions of literal text nodes inside tag children —
 * used by the language server to emit semantic tokens that override the
 * TextMate grammar and ensure text content is styled as plain text rather
 * than as an expression identifier.
 *
 * @param {string} source
 * @returns {{
 *   errors: { message: string, startLine: number, startCol: number, endLine: number, endCol: number }[],
 *   textRanges: { startLine: number, startCol: number, endLine: number, endCol: number }[]
 * }}
 */
function parseCPXNodes(source) {
    const parser = new CPXParser(source);
    parser.textRanges = [];
    try {
        parser.parseModule();
        return { errors: [], textRanges: parser.textRanges };
    } catch (e) {
        if (e instanceof ParseError) {
            return {
                errors: [{
                    message: e.message,
                    startLine: e.startLine,
                    startCol:  e.startCol,
                    endLine:   e.endLine,
                    endCol:    e.endCol,
                }],
                textRanges: parser.textRanges
            };
        }
        return {
            errors: [{ message: String(e), startLine: 0, startCol: 0, endLine: 0, endCol: 1 }],
            textRanges: parser.textRanges
        };
    }
}

module.exports = { parseCPX, parseCPXNodes };
