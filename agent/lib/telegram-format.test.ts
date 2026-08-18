import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkMarkdown,
  escHtml,
  htmlToPlain,
  mdToTelegramHtml,
  needsRichMessage,
  sanitizeTelegramHtml,
  toTelegramHtmlChunks,
} from "./telegram-format.ts";

await test("escaping and plain fallback preserve the existing entity order", () => {
  assert.equal(escHtml("<&>"), "&lt;&amp;&gt;");
  assert.equal(
    htmlToPlain("<b>a &amp;lt; &quot;quoted&quot;</b>"),
    'a &lt; "quoted"',
  );
});

await test("sanitizer repairs crossings and neutralizes unsupported markup", () => {
  assert.equal(
    sanitizeTelegramHtml("<b><i>x</b>y</i><script>x</script>&"),
    "<b><i>x</i></b><i>y</i>&lt;script&gt;x&lt;/script&gt;&amp;",
  );
  assert.equal(
    sanitizeTelegramHtml("<pre><b>x</b></pre>"),
    "<pre>&lt;b&gt;x&lt;/b&gt;</pre>",
  );
});

await test("markdown conversion retains current Telegram HTML fixtures", () => {
  const markdown =
    "# Title\n\n**bold** [link](https://x.test/?a=1&b=2)\n\n```js\nx < y\n```";

  assert.equal(
    mdToTelegramHtml(markdown),
    '<b>Title</b>\n\n<b>bold</b> <a href="https://x.test/?a=1&amp;b=2">link</a>\n\n<pre><code class="language-js">x &lt; y</code></pre>',
  );
});

await test("prose that looks like a code placeholder survives intact", () => {
  // Regression: the inline-code placeholder used to be "two spaces, index, two
  // spaces", so ordinary prose with the same shape reached the chat mangled —
  // the text vanished or was replaced by an unrelated code span.
  assert.equal(
    mdToTelegramHtml("the price is  50  dollars"),
    "the price is  50  dollars",
  );
  assert.equal(
    mdToTelegramHtml("run `ls` then  0  items"),
    "run <code>ls</code> then  0  items",
  );
  assert.equal(mdToTelegramHtml("| a  |  1  |  2  |"), "| a  |  1  |  2  |");
});

await test("an inbound placeholder cannot forge a code span", () => {
  // U+E000/U+E001 are stripped on entry, so a "placeholder" sent from outside stays
  // ordinary text while the real code span is restored exactly once.
  assert.equal(
    mdToTelegramHtml("\uE0000\uE001 forged and `real`"),
    "0 forged and <code>real</code>",
  );
});

await test("chunking and rich routing keep their current boundaries", () => {
  assert.deepEqual(chunkMarkdown("a\n\nb\n\nc", 3), ["a", "b", "c"]);
  assert.deepEqual(toTelegramHtmlChunks("", 10), [""]);

  const chunks = toTelegramHtmlChunks(`**${"x".repeat(200)}**`, 40);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 40);
    assert.equal(sanitizeTelegramHtml(chunk), chunk);
  }

  assert.equal(needsRichMessage("- [ ] todo"), true);
  assert.equal(needsRichMessage("**bold** and `code`"), false);
});
