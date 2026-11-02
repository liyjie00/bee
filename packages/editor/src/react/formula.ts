/**
 * A small spreadsheet formula engine for doc tables. A cell whose text starts with `=` is a formula;
 * it may use numbers, cell refs (A1, $B$2), ranges (A1:C3), + - * / ^ %, comparisons, & (concat),
 * parentheses and a handful of functions. Everything else is a literal.
 */

export type FormulaError = '#REF!' | '#DIV/0!' | '#VALUE!' | '#NAME?' | '#ERROR!' | '#CYCLE!';
export type CellValue = number | string | boolean | null;

class FError extends Error {
  constructor(public code: FormulaError) {
    super(code);
  }
}

export const isFormula = (text: string): boolean => text.trimStart().startsWith('=') && text.trim().length > 1;

/** "A" -> 0, "Z" -> 25, "AA" -> 26. */
export function columnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
export function columnName(index: number): string {
  let s = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** Parses a literal cell: numbers like "1,234.5", "-3", "12%" become numbers; blank is null. */
function literal(text: string): CellValue {
  const t = text.trim();
  if (!t) return null;
  const m = /^([+-]?)(?:\$|¥|￥)?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?|\.\d+)(%?)$/.exec(t);
  if (!m) return t;
  const n = Number(m[2]!.replace(/,/g, '')) * (m[1] === '-' ? -1 : 1);
  return m[3] ? n / 100 : n;
}

type Token =
  | { t: 'num'; v: number }
  | { t: 'str'; v: string }
  | { t: 'ref'; col: number; row: number }
  | { t: 'name'; v: string }
  | { t: 'op'; v: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    let m: RegExpExecArray | null;
    if (/^\s/.test(rest)) {
      i++;
    } else if ((m = /^(\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?/i.exec(rest))) {
      out.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
    } else if ((m = /^"((?:[^"]|"")*)"/.exec(rest)) || (m = /^[“”]([^“”]*)[“”]/.exec(rest))) {
      out.push({ t: 'str', v: m[1]!.replace(/""/g, '"') });
      i += m[0].length;
    } else if ((m = /^\$?([A-Za-z]{1,3})\$?(\d+)(?![A-Za-z0-9_(])/.exec(rest))) {
      out.push({ t: 'ref', col: columnIndex(m[1]!), row: Number(m[2]) - 1 });
      i += m[0].length;
    } else if ((m = /^[A-Za-z_][A-Za-z0-9_.]*/.exec(rest))) {
      out.push({ t: 'name', v: m[0].toUpperCase() });
      i += m[0].length;
    } else if ((m = /^(<=|>=|<>|!=|[-+*/^%&=<>(),:;，（）：；])/.exec(rest))) {
      // Full-width punctuation from Chinese IMEs is accepted as its ASCII twin.
      const map: Record<string, string> = { '，': ',', '（': '(', '）': ')', '：': ':', '；': ',', ';': ',', '!=': '<>' };
      out.push({ t: 'op', v: map[m[0]] ?? m[0] });
      i += m[0].length;
    } else {
      throw new FError('#ERROR!');
    }
  }
  return out;
}

type Node =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'ref'; col: number; row: number }
  | { k: 'range'; c1: number; r1: number; c2: number; r2: number }
  | { k: 'neg'; e: Node }
  | { k: 'pct'; e: Node }
  | { k: 'bin'; op: string; a: Node; b: Node }
  | { k: 'call'; name: string; args: Node[] };

function parse(tokens: Token[]): Node {
  let p = 0;
  const peek = () => tokens[p];
  const isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new FError('#ERROR!');
    p++;
  };

  const binary = (ops: string[], next: () => Node) => (): Node => {
    let a = next();
    while (peek()?.t === 'op' && ops.includes((peek() as { v: string }).v)) {
      const op = (tokens[p++] as { v: string }).v;
      a = { k: 'bin', op, a, b: next() };
    }
    return a;
  };

  const primary = (): Node => {
    const tok = tokens[p++];
    if (!tok) throw new FError('#ERROR!');
    if (tok.t === 'num') return { k: 'num', v: tok.v };
    if (tok.t === 'str') return { k: 'str', v: tok.v };
    if (tok.t === 'ref') {
      if (isOp(':')) {
        p++;
        const end = tokens[p++];
        if (end?.t !== 'ref') throw new FError('#REF!');
        return {
          k: 'range',
          c1: Math.min(tok.col, end.col),
          r1: Math.min(tok.row, end.row),
          c2: Math.max(tok.col, end.col),
          r2: Math.max(tok.row, end.row),
        };
      }
      return { k: 'ref', col: tok.col, row: tok.row };
    }
    if (tok.t === 'name') {
      if (isOp('(')) {
        p++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(compare());
          while (isOp(',')) {
            p++;
            args.push(compare());
          }
        }
        expect(')');
        return { k: 'call', name: tok.v, args };
      }
      if (tok.v === 'TRUE' || tok.v === 'FALSE') return { k: 'bool', v: tok.v === 'TRUE' };
      throw new FError('#NAME?');
    }
    if (tok.v === '(') {
      const e = compare();
      expect(')');
      return e;
    }
    if (tok.v === '-') return { k: 'neg', e: power() };
    if (tok.v === '+') return power();
    throw new FError('#ERROR!');
  };
  const postfix = (): Node => {
    let e = primary();
    while (isOp('%')) {
      p++;
      e = { k: 'pct', e };
    }
    return e;
  };
  const power = binary(['^'], postfix);
  const product = binary(['*', '/'], power);
  const sum = binary(['+', '-'], product);
  const concat = binary(['&'], sum);
  const compare = binary(['=', '<>', '<', '>', '<=', '>='], concat);

  const root = compare();
  if (p !== tokens.length) throw new FError('#ERROR!');
  return root;
}

/** Text of each cell, row-major; `grid[row][col]`. Missing cells read as blank. */
export type Grid = readonly (readonly string[])[];

/** Evaluates every cell of a table. Literal cells yield their parsed value, formulas their result. */
export class Sheet {
  private cache = new Map<string, CellValue | FError>();
  private visiting = new Set<string>();

  constructor(private grid: Grid) {}

  private text(row: number, col: number): string | undefined {
    return this.grid[row]?.[col];
  }

  /** Value of a cell; throws FError for a formula that errors. */
  private value(row: number, col: number): CellValue {
    const text = this.text(row, col);
    if (text === undefined) throw new FError('#REF!');
    if (!isFormula(text)) return literal(text);
    const key = `${row}:${col}`;
    const cached = this.cache.get(key);
    if (cached instanceof FError) throw cached;
    if (cached !== undefined) return cached;
    if (this.visiting.has(key)) throw new FError('#CYCLE!');
    this.visiting.add(key);
    let result: CellValue | FError;
    try {
      result = this.evalNode(parse(tokenize(text.trim().slice(1))));
      if (typeof result === 'number' && !Number.isFinite(result)) result = new FError('#DIV/0!');
    } catch (err) {
      result = err instanceof FError ? err : new FError('#ERROR!');
    } finally {
      this.visiting.delete(key);
    }
    this.cache.set(key, result);
    if (result instanceof FError) throw result;
    return result;
  }

  /** The display value of a cell, or the error code it produced. */
  evaluate(row: number, col: number): CellValue | FormulaError {
    try {
      return this.value(row, col);
    } catch (err) {
      return err instanceof FError ? err.code : '#ERROR!';
    }
  }

  /** True when the cell is a formula that produced an error. */
  isError(row: number, col: number): boolean {
    this.evaluate(row, col);
    return this.cache.get(`${row}:${col}`) instanceof FError;
  }

  private rangeValues(n: Node): CellValue[] {
    if (n.k === 'range') {
      const vals: CellValue[] = [];
      // Ranges are clipped to the table, so SUM(A2:A99) keeps working as rows are added.
      for (let r = n.r1; r <= Math.min(n.r2, this.grid.length - 1); r++) {
        for (let c = n.c1; c <= n.c2; c++) {
          if (this.text(r, c) !== undefined) vals.push(this.value(r, c));
        }
      }
      return vals;
    }
    return [this.evalNode(n)];
  }

  private num(v: CellValue): number {
    if (v === null) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? 1 : 0;
    const lit = literal(v);
    if (typeof lit === 'number') return lit;
    throw new FError('#VALUE!');
  }

  private evalNode(n: Node): CellValue {
    switch (n.k) {
      case 'num':
      case 'str':
      case 'bool':
        return n.v;
      case 'ref':
        return this.value(n.row, n.col);
      case 'range':
        throw new FError('#VALUE!');
      case 'neg':
        return -this.num(this.evalNode(n.e));
      case 'pct':
        return this.num(this.evalNode(n.e)) / 100;
      case 'bin':
        return this.binary(n.op, this.evalNode(n.a), this.evalNode(n.b));
      case 'call':
        return this.call(n.name, n.args);
    }
  }

  private binary(op: string, a: CellValue, b: CellValue): CellValue {
    switch (op) {
      case '+':
        return this.num(a) + this.num(b);
      case '-':
        return this.num(a) - this.num(b);
      case '*':
        return this.num(a) * this.num(b);
      case '/': {
        const d = this.num(b);
        if (d === 0) throw new FError('#DIV/0!');
        return this.num(a) / d;
      }
      case '^':
        return this.num(a) ** this.num(b);
      case '&':
        return display(a) + display(b);
    }
    // Comparisons: numbers numerically, otherwise case-insensitive text.
    const both = typeof a !== 'string' && typeof b !== 'string';
    const x = both ? this.num(a) : display(a).toLowerCase();
    const y = both ? this.num(b) : display(b).toLowerCase();
    switch (op) {
      case '=':
        return x === y;
      case '<>':
        return x !== y;
      case '<':
        return x < y;
      case '>':
        return x > y;
      case '<=':
        return x <= y;
      case '>=':
        return x >= y;
    }
    throw new FError('#ERROR!');
  }

  private call(name: string, args: Node[]): CellValue {
    const all = () => args.flatMap((a) => this.rangeValues(a));
    // Aggregates skip text and blanks, like spreadsheets do.
    const nums = () => all().filter((v): v is number => typeof v === 'number');
    const arg = (i: number) => {
      const a = args[i];
      if (!a) throw new FError('#VALUE!');
      return this.evalNode(a);
    };
    switch (name) {
      case 'SUM':
        return nums().reduce((s, v) => s + v, 0);
      case 'AVERAGE':
      case 'AVG': {
        const v = nums();
        if (!v.length) throw new FError('#DIV/0!');
        return v.reduce((s, x) => s + x, 0) / v.length;
      }
      case 'MIN':
        return nums().length ? Math.min(...nums()) : 0;
      case 'MAX':
        return nums().length ? Math.max(...nums()) : 0;
      case 'COUNT':
        return nums().length;
      case 'COUNTA':
        return all().filter((v) => v !== null && v !== '').length;
      case 'PRODUCT':
        return nums().reduce((s, v) => s * v, 1);
      case 'ABS':
        return Math.abs(this.num(arg(0)));
      case 'SQRT': {
        const v = this.num(arg(0));
        if (v < 0) throw new FError('#VALUE!');
        return Math.sqrt(v);
      }
      case 'ROUND':
      case 'ROUNDUP':
      case 'ROUNDDOWN': {
        const digits = args[1] ? this.num(arg(1)) : 0;
        const f = 10 ** digits;
        const v = this.num(arg(0)) * f;
        const r = name === 'ROUND' ? Math.round(v) : name === 'ROUNDUP' ? Math.sign(v) * Math.ceil(Math.abs(v)) : Math.trunc(v);
        return r / f;
      }
      case 'INT':
        return Math.floor(this.num(arg(0)));
      case 'MOD': {
        const d = this.num(arg(1));
        if (d === 0) throw new FError('#DIV/0!');
        const v = this.num(arg(0));
        return v - d * Math.floor(v / d);
      }
      case 'POWER':
        return this.num(arg(0)) ** this.num(arg(1));
      case 'IF': {
        const cond = arg(0);
        const truthy = typeof cond === 'string' ? cond !== '' : !!cond;
        if (truthy) return args[1] ? arg(1) : true;
        return args[2] ? arg(2) : false;
      }
      case 'AND':
        return all().every((v) => !!this.num(v));
      case 'OR':
        return all().some((v) => !!this.num(v));
      case 'NOT':
        return !this.num(arg(0));
      case 'CONCAT':
      case 'CONCATENATE':
        return all().map(display).join('');
      case 'LEN':
        return display(arg(0)).length;
      case 'UPPER':
        return display(arg(0)).toUpperCase();
      case 'LOWER':
        return display(arg(0)).toLowerCase();
      case 'PI':
        return Math.PI;
    }
    throw new FError('#NAME?');
  }
}

/** Formats a value for display; floats are trimmed of binary noise (0.1+0.2 shows 0.3). */
export function display(v: CellValue): string {
  if (v === null) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return String(Number(v.toPrecision(12)));
  return v;
}
