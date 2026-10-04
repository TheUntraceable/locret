import { memo, useMemo } from 'react';
import Markdown, { MarkdownIt, type RenderRules } from '@ronradtke/react-native-markdown-display';
import { useThemeColor } from 'heroui-native';

type MarkdownRendererProps = {
  content: string;
  /** 'muted' renders smaller, dimmer text (used for thinking). */
  tone?: 'default' | 'muted';
};

/**
 * One parser shared by every renderer. The library's default prop builds a new
 * MarkdownIt instance on every render, the most expensive part of a re-render.
 */
const markdownParser = MarkdownIt({ typographer: true });

/**
 * Remote images are never loaded: model output must not make a private,
 * offline chat fetch arbitrary URLs (e.g. tracking pixels).
 */
const RULES: RenderRules = {
  image: () => null,
};

/**
 * Links open only when tapped (nothing is fetched on render), and only for web
 * and mail links: model output must not be able to fire app deep links,
 * `intent:`/`tel:`/`sms:` URLs and the like. Returning true lets the library
 * open the URL.
 */
const onLinkPress = (url: string): boolean => /^(https?:|mailto:)/i.test(url.trim());

/** Greek letter map for LaTeX → Unicode. */
const GREEK: Record<string, string> = {
  alpha: '\u03B1', beta: '\u03B2', gamma: '\u03B3', delta: '\u03B4', epsilon: '\u03B5',
  zeta: '\u03B6', eta: '\u03B7', theta: '\u03B8', iota: '\u03B9', kappa: '\u03BA',
  lambda: '\u03BB', mu: '\u03BC', nu: '\u03BD', xi: '\u03BE', pi: '\u03C0',
  rho: '\u03C1', sigma: '\u03C3', tau: '\u03C4', upsilon: '\u03C5', phi: '\u03C6',
  chi: '\u03C7', psi: '\u03C8', omega: '\u03C9',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Epsilon: '\u0395',
  Zeta: '\u0396', Eta: '\u0397', Theta: '\u0398', Iota: '\u0399', Kappa: '\u039A',
  Lambda: '\u039B', Mu: '\u039C', Nu: '\u039D', Xi: '\u039E', Pi: '\u03A0',
  Rho: '\u03A1', Sigma: '\u03A3', Tau: '\u03A4', Upsilon: '\u03A5', Phi: '\u03A6',
  Chi: '\u03A7', Psi: '\u03A8', Omega: '\u03A9',
};

/** Symbol map for common LaTeX commands → Unicode. */
const SYMBOLS: Record<string, string> = {
  infty: '\u221E', partial: '\u2202', nabla: '\u2207', cdot: '\u00B7',
  times: '\u00D7', div: '\u00F7', pm: '\u00B1', mp: '\u2213',
  leq: '\u2264', geq: '\u2265', neq: '\u2260', approx: '\u2248',
  equiv: '\u2261', subset: '\u2282', supset: '\u2283', cup: '\u222A',
  cap: '\u2229', in: '\u2208', notin: '\u2209', forall: '\u2200',
  exists: '\u2203', sqrt: '\u221A', sum: '\u2211', prod: '\u220F',
  int: '\u222B', leftarrow: '\u2190', rightarrow: '\u2192',
  Leftarrow: '\u21D0', Rightarrow: '\u21D2', leftrightarrow: '\u2194',
  to: '\u2192', dots: '\u2026', cdots: '\u22EF', ldots: '\u2026',
  land: '\u2227', lor: '\u2228', neg: '\u00AC', lnot: '\u00AC',
  quad: '  ', qquad: '    ',
};

const SUPERSCRIPTS: Record<string, string> = {
  '0': '\u2070', '1': '\u00B9', '2': '\u00B2', '3': '\u00B3', '4': '\u2074',
  '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079',
  '+': '\u207A', '-': '\u207B', '=': '\u207C', '(': '\u207D', ')': '\u207E',
  n: '\u207F', i: '\u2071',
};

const SUBSCRIPTS: Record<string, string> = {
  '0': '\u2080', '1': '\u2081', '2': '\u2082', '3': '\u2083', '4': '\u2084',
  '5': '\u2085', '6': '\u2086', '7': '\u2087', '8': '\u2088', '9': '\u2089',
  '+': '\u208A', '-': '\u208B', '=': '\u208C', '(': '\u208D', ')': '\u208E',
  a: '\u2090', e: '\u2091', o: '\u2092', x: '\u2093', i: '\u1D62',
  j: '\u2C7C', k: '\u2096', n: '\u2099', p: '\u209A', r: '\u1D63',
  s: '\u209B', t: '\u209C',
};

/** Convert a short string to superscript Unicode where possible. */
function toSuperscript(s: string): string {
  return [...s].map((c) => SUPERSCRIPTS[c] ?? c).join('');
}

/** Convert a short string to subscript Unicode where possible. */
function toSubscript(s: string): string {
  return [...s].map((c) => SUBSCRIPTS[c] ?? c).join('');
}

/** Strip the outermost braces from a string if present: {abc} → abc */
function stripBraces(s: string): string {
  s = s.trim();
  if (s.startsWith('{') && s.endsWith('}')) return s.slice(1, -1);
  return s;
}

/**
 * Read a LaTeX argument: either a single character or a brace-delimited group.
 * Returns [argument, restOfString].
 */
function readArg(s: string): [string, string] {
  s = s.trimStart();
  if (s.startsWith('{')) {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '{') depth++;
      else if (s[i] === '}') {
        depth--;
        if (depth === 0) return [s.slice(1, i), s.slice(i + 1)];
      }
    }
    // Unbalanced — return everything
    return [s.slice(1), ''];
  }
  // Single character
  return s.length > 0 ? [s[0], s.slice(1)] : ['', ''];
}

/** Convert LaTeX math content to readable Unicode text. */
function latexToUnicode(tex: string): string {
  let result = tex;

  // \frac{a}{b} → (a)/(b)
  while (result.includes('\\frac')) {
    const idx = result.indexOf('\\frac');
    const after = result.slice(idx + 5);
    const [num, rest1] = readArg(after);
    const [den, rest2] = readArg(rest1);
    result = result.slice(0, idx) + `(${latexToUnicode(num)})/(${latexToUnicode(den)})` + rest2;
  }

  // \sqrt{x} → √(x) or \sqrt[n]{x} → ⁿ√(x)
  while (result.includes('\\sqrt')) {
    const idx = result.indexOf('\\sqrt');
    let after = result.slice(idx + 5).trimStart();
    let nthRoot = '';
    if (after.startsWith('[')) {
      const closeBracket = after.indexOf(']');
      if (closeBracket !== -1) {
        nthRoot = toSuperscript(after.slice(1, closeBracket));
        after = after.slice(closeBracket + 1);
      }
    }
    const [arg, rest] = readArg(after);
    result = result.slice(0, idx) + `${nthRoot}\u221A(${latexToUnicode(arg)})` + rest;
  }

  // Greek letters
  for (const [cmd, char] of Object.entries(GREEK)) {
    result = result.replace(new RegExp(`\\\\${cmd}\\b`, 'g'), char);
  }

  // Symbols
  for (const [cmd, char] of Object.entries(SYMBOLS)) {
    result = result.replace(new RegExp(`\\\\${cmd}\\b`, 'g'), char);
  }

  // Superscripts: x^{2} → x² or x^2 → x²
  result = result.replace(/\^(\{[^}]*\}|[^\s{\\])/g, (_, arg) => {
    return toSuperscript(stripBraces(arg));
  });

  // Subscripts: x_{i} → xᵢ or x_i → xᵢ
  result = result.replace(/_(\{[^}]*\}|[^\s{\\])/g, (_, arg) => {
    return toSubscript(stripBraces(arg));
  });

  // \text{...} and \mathrm{...} — just unwrap
  result = result.replace(/\\(?:text|mathrm|mathbf|mathit|textit|textbf)\{([^}]*)\}/g, '$1');

  // \left and \right — just remove
  result = result.replace(/\\(?:left|right)\s*/g, '');

  // \begin{...} / \end{...} — remove
  result = result.replace(/\\(?:begin|end)\{[^}]*\}/g, '');

  // \\ (line break) → newline
  result = result.replace(/\\\\/g, '\n');

  // Remove remaining single backslash commands we didn't handle (e.g. \, \; \! spacing)
  result = result.replace(/\\[,;!>]\s?/g, ' ');

  // Clean up remaining braces
  result = result.replace(/[{}]/g, '');

  // Collapse multiple spaces
  result = result.replace(/  +/g, ' ');

  return result.trim();
}

/** Converts LaTeX math in prose (never code) to Unicode. */
function preprocessLatexProse(content: string): string {
  // Display math: $$...$$
  let result = content.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    return '\n' + latexToUnicode(tex) + '\n';
  });

  // Inline math: $...$. As in pandoc, the opening $ must be followed by a
  // non-space and the closing $ preceded by a non-space and not followed by a
  // digit, so prices ("$5 and $10") are left alone.
  result = result.replace(/\$(?=\S)([^\n$]*?\S)\$(?!\d)/g, (_, tex) => {
    return latexToUnicode(tex);
  });

  // \(...\) inline math
  result = result.replace(/\\\((.+?)\\\)/g, (_, tex) => {
    return latexToUnicode(tex);
  });

  // \[...\] display math
  result = result.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => {
    return '\n' + latexToUnicode(tex) + '\n';
  });

  return result;
}

const FENCE_LINE_RE = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_RE = /(`+)[^`]*?\1/g;

/** Applies `fn` to prose only: fenced code blocks and inline code spans are kept verbatim. */
function mapProse(content: string, fn: (prose: string) => string): string {
  const out: string[] = [];
  let prose: string[] = [];
  let fence = '';
  const flushProse = () => {
    if (prose.length === 0) return;
    const text = prose.join('\n');
    let mapped = '';
    let last = 0;
    for (const m of text.matchAll(INLINE_CODE_RE)) {
      const start = m.index ?? 0;
      mapped += fn(text.slice(last, start)) + m[0];
      last = start + m[0].length;
    }
    out.push(mapped + fn(text.slice(last)));
    prose = [];
  };
  for (const line of content.split('\n')) {
    const marker = FENCE_LINE_RE.exec(line)?.[1];
    if (fence) {
      out.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = '';
    } else if (marker) {
      flushProse();
      fence = marker;
      out.push(line);
    } else {
      prose.push(line);
    }
  }
  flushProse();
  return out.join('\n');
}

/** Pre-process content to convert LaTeX math expressions to Unicode (code is left untouched). */
function preprocessLatex(content: string): string {
  if (!content.includes('$') && !content.includes('\\')) return content;
  return mapProse(content, preprocessLatexProse);
}

/**
 * Markdown with LaTeX→Unicode preprocessing. Memo'd on its props: chat
 * messages render it once per settled block (components/chat/ChunkedMarkdown),
 * so while a reply streams only the block being written is re-parsed.
 */
export const MarkdownRenderer = memo(function MarkdownRenderer({ content, tone = 'default' }: MarkdownRendererProps) {
  const [
    themeForeground,
    themeMuted,
    themeAccent,
    themeSurfaceSecondary,
  ] = useThemeColor(['foreground', 'muted', 'accent', 'surface-secondary']);

  // Pre-process LaTeX into readable Unicode before passing to Markdown
  const processedContent = useMemo(() => preprocessLatex(content), [content]);

  const muted = tone === 'muted';
  const textColor = muted ? themeMuted : themeForeground;

  const mdStyles = useMemo(
    () => ({
      body: { color: textColor, fontSize: muted ? 13 : 14, lineHeight: muted ? 19 : 20 },
      paragraph: { marginTop: 0, marginBottom: 6 },
      heading1: { color: textColor, fontSize: 20, fontWeight: '700' as const, marginBottom: 6, marginTop: 10 },
      heading2: { color: textColor, fontSize: 18, fontWeight: '700' as const, marginBottom: 5, marginTop: 8 },
      heading3: { color: textColor, fontSize: 16, fontWeight: '600' as const, marginBottom: 4, marginTop: 6 },
      heading4: { color: textColor, fontSize: 15, fontWeight: '600' as const, marginBottom: 3, marginTop: 5 },
      heading5: { color: textColor, fontSize: 14, fontWeight: '600' as const, marginBottom: 2, marginTop: 4 },
      heading6: { color: textColor, fontSize: 14, fontWeight: '500' as const, marginBottom: 2, marginTop: 3 },
      strong: { fontWeight: '700' as const },
      em: { fontStyle: 'italic' as const },
      link: { color: themeAccent },
      blockquote: {
        borderLeftWidth: 3,
        borderLeftColor: themeAccent,
        paddingLeft: 12,
        marginLeft: 0,
        marginVertical: 6,
      },
      code_inline: {
        fontFamily: 'monospace',
        backgroundColor: themeSurfaceSecondary,
        color: themeAccent,
        paddingHorizontal: 4,
        paddingVertical: 1,
        borderRadius: 4,
        fontSize: 13,
      },
      code_block: {
        fontFamily: 'monospace',
        backgroundColor: themeSurfaceSecondary,
        color: themeAccent,
        padding: 12,
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 18,
        marginVertical: 6,
      },
      fence: {
        fontFamily: 'monospace',
        backgroundColor: themeSurfaceSecondary,
        color: themeAccent,
        padding: 12,
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 18,
        marginVertical: 6,
      },
      hr: { backgroundColor: themeSurfaceSecondary, marginVertical: 8 },
      bullet_list: { marginVertical: 4 },
      ordered_list: { marginVertical: 4 },
      list_item: { marginVertical: 2 },
      bullet_list_icon: { color: themeMuted, fontSize: 14, marginRight: 6 },
      ordered_list_icon: { color: themeMuted, fontSize: 13, marginRight: 6 },
      s: { textDecorationLine: 'line-through' as const },
    }),
    [textColor, muted, themeMuted, themeAccent, themeSurfaceSecondary],
  );

  return (
    <Markdown style={mdStyles} markdownit={markdownParser} rules={RULES} onLinkPress={onLinkPress}>
      {processedContent}
    </Markdown>
  );
});
