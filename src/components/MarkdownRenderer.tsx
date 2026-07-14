import { useMemo } from 'react';
import Markdown from '@ronradtke/react-native-markdown-display';
import { useThemeColor } from 'heroui-native';

type MarkdownRendererProps = {
  content: string;
  isStreaming?: boolean;
};

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

  // \frac{a}{b} → a/b
  result = result.replace(/\\frac\s*/g, (_, offset) => {
    const after = result.slice(offset + _.length);
    const [num, rest1] = readArg(after);
    const [den, rest2] = readArg(rest1);
    const replacement = `${latexToUnicode(num)}/${latexToUnicode(den)}`;
    // We need to rebuild result from this point
    result = result.slice(0, offset) + replacement + rest2;
    return ''; // handled via mutation
  });
  // Re-run frac since the regex replace above is tricky with mutations — use iterative approach
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

  // Superscripts: x^{2} → x² or x^2 → x²
  result = result.replace(/\^(\{[^}]*\}|[^\s{\\])/g, (_, arg) => {
    return toSuperscript(stripBraces(arg));
  });

  // Subscripts: x_{i} → xᵢ or x_i → xᵢ
  result = result.replace(/_(\{[^}]*\}|[^\s{\\])/g, (_, arg) => {
    return toSubscript(stripBraces(arg));
  });

  // Greek letters
  for (const [cmd, char] of Object.entries(GREEK)) {
    result = result.replace(new RegExp(`\\\\${cmd}\\b`, 'g'), char);
  }

  // Symbols
  for (const [cmd, char] of Object.entries(SYMBOLS)) {
    result = result.replace(new RegExp(`\\\\${cmd}\\b`, 'g'), char);
  }

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

/** Pre-process content to convert LaTeX math expressions to Unicode. */
function preprocessLatex(content: string): string {
  // Display math: $$...$$
  let result = content.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => {
    return '\n' + latexToUnicode(tex) + '\n';
  });

  // Inline math: $...$  (but not lone $ signs)
  result = result.replace(/\$([^\n$]+?)\$/g, (_, tex) => {
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

export function MarkdownRenderer({ content, isStreaming }: MarkdownRendererProps) {
  const [
    themeForeground,
    themeMuted,
    themeAccent,
    themeSurfaceSecondary,
  ] = useThemeColor(['foreground', 'muted', 'accent', 'surface-secondary']);

  // Pre-process LaTeX into readable Unicode before passing to Markdown
  const processedContent = useMemo(() => preprocessLatex(content), [content]);

  const mdStyles = useMemo(
    () => ({
      body: { color: themeForeground, fontSize: 14, lineHeight: 20 },
      paragraph: { marginTop: 0, marginBottom: 6 },
      heading1: { color: themeForeground, fontSize: 20, fontWeight: '700' as const, marginBottom: 6, marginTop: 10 },
      heading2: { color: themeForeground, fontSize: 18, fontWeight: '700' as const, marginBottom: 5, marginTop: 8 },
      heading3: { color: themeForeground, fontSize: 16, fontWeight: '600' as const, marginBottom: 4, marginTop: 6 },
      heading4: { color: themeForeground, fontSize: 15, fontWeight: '600' as const, marginBottom: 3, marginTop: 5 },
      heading5: { color: themeForeground, fontSize: 14, fontWeight: '600' as const, marginBottom: 2, marginTop: 4 },
      heading6: { color: themeForeground, fontSize: 14, fontWeight: '500' as const, marginBottom: 2, marginTop: 3 },
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
    [themeForeground, themeMuted, themeAccent, themeSurfaceSecondary],
  );

  return <Markdown style={mdStyles}>{processedContent}</Markdown>;
}
