import { buildStatementHtml } from '../src/webview';
import { parseProblemPage } from '../src/scraper';

const FIXTURE = `<!DOCTYPE html><html><body>
<div class="problem-statement">
  <div class="header">
    <div class="title">C. Bipartite Segments</div>
    <div class="time-limit">time limit per test<span>2 seconds</span></div>
    <div class="memory-limit">memory limit per test<span>256 megabytes</span></div>
  </div>
  <div><p>You are given an undirected graph with $$$n$$$ vertices and $$$m$$$ edges.</p>
  <p>Count pairs $$$(l, r)$$$ with $$$$$$\\sum_{i=l}^{r} a_i \\le k$$$$$$.</p>
  <ul><li>the graph is <span class="tex-font-style-bf">bipartite</span>;</li><li>no vertex degree exceeds 2.</li></ul></div>
  <div class="input-specification"><div class="section-title">Input</div>
    <p>The first line contains $$$n$$$ and $$$m$$$ ($$$1 \\le n, m \\le 3 \\cdot 10^5$$$).</p></div>
  <div class="output-specification"><div class="section-title">Output</div>
    <p>Print a single integer.</p></div>
  <div class="sample-tests">
    <div class="sample-test">
      <div class="input"><div class="title">Input</div><pre>3 5
1 2
2 3</pre></div>
      <div class="output"><div class="title">Output</div><pre>4</pre></div>
    </div>
  </div>
  <div class="note"><div class="section-title">Note</div><p>The answer for $$$n = 3$$$ is $$$4$$$.</p></div>
</div></body></html>`;

export function renderPreview(): string {
  const statement = parseProblemPage(
    FIXTURE,
    { contestId: '2045', index: 'C', kind: 'contest' },
    'https://codeforces.com/contest/2045/problem/C',
  );
  return buildStatementHtml(statement, { katexScript: '../media/katex/katex.min.js', katexStyle: '../media/katex/katex.min.css', cspSource: 'file:' });
}
